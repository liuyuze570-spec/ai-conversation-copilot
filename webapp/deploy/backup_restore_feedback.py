"""发布前备份 / 发布后恢复反馈库（纯文件复制 + sha256 校验，不连线上数据库）。

用法（在任意目录执行均可，默认路径按本文件位置解析）：
    python backup_restore_feedback.py backup
    python backup_restore_feedback.py restore
    python backup_restore_feedback.py backup  --data-dir DIR --backup-dir DIR
    python backup_restore_feedback.py restore --file /path/to/feedback-20261109-203000.sqlite3

也可用环境变量 COPILOT_DATA_DIR / COPILOT_FEEDBACK_BACKUP_DIR 指定目录。

=============================================================================
重要限制（如实说明，不拿本地文件复制冒充「线上已跨部署持久」）
=============================================================================
本脚本只在你自己能读写的目录之间搬运 feedback.sqlite3 这一个文件，
不连接任何线上数据库、不假设平台提供什么 API。

平台是否有持久卷**未知**。若 COPILOT_DATA_DIR 指向的是随发布被覆盖的临时目录，
那么「备份 → 重新部署 → 恢复」能否生效，取决于备份文件是否被保存在发布流程
之外的地方（例如上传到你自己的持久存储），以及恢复步骤有没有接进发布流程。

要真正做到「重新部署后原编号仍可查」，必须满足其一：
  1. 平台提供持久目录并挂载到容器（见 Dockerfile 的 VOLUME、docker-compose.yml
     的 volumes），让 COPILOT_DATA_DIR 指向它；或
  2. 改用外置数据库（把 feedback_store.py 的 SQLite 文件换成网络 DB）。

只把库文件复制进镜像 / 发布目录，下一次发布会再次覆盖它 —— 本脚本不承诺这一点。
执行时机：建议停服后、发布前做 backup；发布完成、服务启动前做 restore，
避免复制过程中库仍被写入导致文件不一致。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = (HERE.parent / "server" / "data").resolve()
DEFAULT_BACKUP_DIR = (HERE / "feedback-backups").resolve()
DB_NAME = "feedback.sqlite3"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sidecar(path: Path) -> Path:
    return Path(str(path) + ".sha256")


def stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def do_backup(data_dir: Path, backup_dir: Path) -> int:
    src = data_dir / DB_NAME
    if not src.is_file():
        print(f"[backup] 找不到库文件：{src}（还没有任何反馈，跳过）")
        return 0
    backup_dir.mkdir(parents=True, exist_ok=True)
    dst = backup_dir / f"feedback-{stamp()}.sqlite3"
    seq = 1
    while dst.exists():  # 同一秒内重复执行不覆盖
        dst = backup_dir / f"feedback-{stamp()}-{seq}.sqlite3"
        seq += 1
    shutil.copy2(src, dst)
    src_hash, dst_hash = sha256(src), sha256(dst)
    sidecar(dst).write_text(dst_hash + "\n", encoding="utf-8")
    if src_hash != dst_hash:
        print(f"[backup] 校验失败：{src_hash} != {dst_hash}")
        return 1
    print(f"[backup] OK {src} -> {dst} sha256={dst_hash} bytes={dst.stat().st_size}")
    return 0


def do_restore(data_dir: Path, backup_dir: Path, file: str | None) -> int:
    if file:
        src = Path(file).resolve()
    else:
        candidates = sorted(backup_dir.glob("feedback-*.sqlite3"))
        if not candidates:
            print(f"[restore] 备份目录里没有备份文件：{backup_dir}")
            return 1
        src = candidates[-1]
    if not src.is_file():
        print(f"[restore] 找不到备份文件：{src}")
        return 1
    expected_file = sidecar(src)
    if expected_file.is_file():
        expected = expected_file.read_text(encoding="utf-8").strip()
        actual = sha256(src)
        if expected != actual:
            print(f"[restore] 校验失败：{expected} != {actual}，拒绝恢复")
            return 1
    data_dir.mkdir(parents=True, exist_ok=True)
    dst = data_dir / DB_NAME
    if dst.exists():
        keep = Path(str(dst) + ".before-restore-" + stamp())
        shutil.copy2(dst, keep)
        print(f"[restore] 现有库已另存：{keep}")
    shutil.copy2(src, dst)
    if sha256(src) != sha256(dst):
        print("[restore] 复制后校验失败")
        return 1
    print(f"[restore] OK {src} -> {dst} bytes={dst.stat().st_size}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="反馈库发布前备份 / 发布后恢复（纯文件复制）")
    parser.add_argument("action", choices=("backup", "restore"))
    parser.add_argument("--data-dir", default=None, help="反馈库目录（默认 COPILOT_DATA_DIR 或 server/data）")
    parser.add_argument("--backup-dir", default=None, help="备份目录（默认 deploy/feedback-backups）")
    parser.add_argument("--file", default=None, help="restore 时指定备份文件；默认取最新一份")
    args = parser.parse_args()

    data_dir = Path(args.data_dir or os.environ.get("COPILOT_DATA_DIR") or DEFAULT_DATA_DIR).resolve()
    backup_dir = Path(
        args.backup_dir or os.environ.get("COPILOT_FEEDBACK_BACKUP_DIR") or DEFAULT_BACKUP_DIR
    ).resolve()
    if args.action == "backup":
        return do_backup(data_dir, backup_dir)
    return do_restore(data_dir, backup_dir, args.file)


if __name__ == "__main__":
    sys.exit(main())
