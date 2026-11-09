"""进程级断网守卫：除回环以外，一切出站连接都拦下来并记账。

为什么单独一个模块：离线验证（`offline_check.py`）和离线便携版的启动器
（`run_offline.py --guard`）都要用同一套规则。两处各写一份，迟早会不一致，
而「到底拦没拦」这件事不该有两种答案。

用法：

    from offline_guard import install, blocked, reset
    install()          # 必须在 import 任何联网库之前调用
    ...                # 跑业务
    print(blocked())   # 0 表示整条链路根本没试过联网

注意：这是**进程级**限制，不是拔网线。系统级断网需要管理员权限，会打断同机
其它验证，本仓库没有做，也不声称做过。
"""

from __future__ import annotations

import socket

BLOCKED: list[str] = []

_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_getaddrinfo = socket.getaddrinfo

_installed = False


def _is_loopback(host) -> bool:
    if isinstance(host, bytes):
        host = host.decode("utf-8", "ignore")
    if not isinstance(host, str):
        return False
    return host in ("127.0.0.1", "::1", "localhost", "") or host.startswith("127.")


def _guard_connect(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if isinstance(address, tuple) and _is_loopback(host):
        return _real_connect(self, address)
    BLOCKED.append(f"connect {address!r}")
    raise OSError("offline-guard: 出站连接被拦截")


def _guard_connect_ex(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if isinstance(address, tuple) and _is_loopback(host):
        return _real_connect_ex(self, address)
    BLOCKED.append(f"connect_ex {address!r}")
    return 111


def _guard_getaddrinfo(host, *args, **kwargs):
    if _is_loopback(host):
        return _real_getaddrinfo(host, *args, **kwargs)
    BLOCKED.append(f"getaddrinfo {host!r}")
    raise socket.gaierror("offline-guard: 域名解析被拦截")


def install() -> None:
    """把 socket 的三个出口换成拦截版。重复调用无副作用。"""
    global _installed
    if _installed:
        return
    socket.socket.connect = _guard_connect
    socket.socket.connect_ex = _guard_connect_ex
    socket.getaddrinfo = _guard_getaddrinfo
    _installed = True


def blocked() -> list[str]:
    return list(BLOCKED)


def reset() -> None:
    BLOCKED.clear()
