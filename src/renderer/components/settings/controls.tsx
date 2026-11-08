import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * 设置面板里复用的基础控件。
 *
 * 单独拆一个文件的原因：设置页被分成「常用功能 / API 功能」两个标签后，
 * 两边都要用这些小控件，放在一个 600 行的文件里已经没人看得懂了。
 */

/**
 * 「这一行的文字标签」的 id，交给行内的控件做无障碍名称。
 *
 * 为什么用 context 而不是让每个调用点手写 `aria-label`：设置页有几十个 Row，
 * 逐个补名字必然会漏，而漏掉的那个读屏只念「按钮」。Row 生成 id、控件自动
 * 接上 `aria-labelledby`，新加行时名字天然是对的。
 *
 * 注意：`<label for>` 在这里没用 —— 行内控件是 `button[role=combobox]`
 * 和自绘开关，labelable element 只有 input/select/textarea 那几个。
 */
const RowLabelContext = createContext<string | undefined>(undefined);

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-3 rounded-xl border border-line-soft bg-ink-850 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">{title}</p>
        {aside}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <span id={labelId} className="shrink-0 text-[11.5px] text-white/55">
        {label}
      </span>
      <RowLabelContext.Provider value={labelId}>{children}</RowLabelContext.Provider>
    </div>
  );
}

export function Hint({ children, dataAttr }: { children: ReactNode; dataAttr?: string }) {
  return (
    <p
      {...(dataAttr ? { [dataAttr]: '' } : {})}
      className="mt-1 text-[10px] leading-relaxed text-white/30"
    >
      {children}
    </p>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className="flex w-full items-center justify-between rounded-md px-0.5 py-[2px] text-left"
      >
        <span className="text-[11.5px] text-white/55">{label}</span>
        <span
          className={`relative h-4 w-8 shrink-0 rounded-full transition ${
            value ? 'bg-accent/80' : 'bg-white/15'
          }`}
        >
          <span
            className={`absolute top-[2px] h-3 w-3 rounded-full bg-white transition-all ${
              value ? 'left-[18px]' : 'left-[2px]'
            }`}
          />
        </span>
      </button>
      {hint && <p className="mt-0.5 px-0.5 text-[10px] text-white/25">{hint}</p>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  align = 'right',
  placeholder,
  type = 'text',
  onBlur,
  dataAttr,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  align?: 'left' | 'right';
  placeholder?: string;
  type?: string;
  onBlur?: () => void;
  dataAttr?: string;
  ariaLabel?: string;
}) {
  const rowLabelId = useContext(RowLabelContext);
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      /*
       * 名称优先用调用点给的准确名字，其次用同一行左边那行字的 id；
       * 都没有才退回 placeholder。之前统一挂 placeholder，读屏念出来是
       * 「请选择」「输入名字」这类不完整的话，而且几个框名字一模一样。
       */
      {...(ariaLabel
        ? { 'aria-label': ariaLabel }
        : rowLabelId
          ? { 'aria-labelledby': rowLabelId }
          : { 'aria-label': placeholder })}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      {...(dataAttr ? { [dataAttr]: '' } : {})}
      className={`no-drag w-32 rounded-md border border-line-soft bg-ink-800 px-2 py-1 text-[11px] text-white/90 placeholder:text-white/25 focus:border-accent/50 focus:outline-none ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    />
  );
}

/**
 * 下拉选择器（自绘，不用原生 `<select>`）。
 *
 * 为什么不用原生 select：这个窗口是「无边框 + 置顶 screen-saver」，设置面板
 * 又带 `backdrop-blur` 且内部可滚动。原生下拉的弹出层是操作系统单独开的窗口，
 * 在这种环境下经常点不动 / 弹出后被裁掉（用户反馈「回复风格怎么点都换不了，
 * 一直停在 natural」）。
 *
 * 改成 DOM 内自绘 + portal 到 body + position: fixed：
 * - 用 portal 是因为面板祖先有 `backdrop-filter`，它会让 fixed 定位退回成
 *   相对面板定位，再被 `overflow-y-auto` 裁掉；挂到 body 就没这个问题。
 * - 位置在打开时按触发器 rect 现算，下面放不下就朝上弹。
 *
 * 键盘（0.4.0 补）：Tab 到触发器 → Enter/空格/↓ 打开 → ↑↓ 移动 →
 * Enter 确认 → Esc 退出；连打字母按首字母跳。焦点全程留在触发器上，
 * 用 `aria-activedescendant` 告诉读屏「现在停在哪个选项」——这是 combobox
 * 的标准做法，也避免了焦点掉进 portal 里再回不来的老问题。
 */
export function Select({
  value,
  options,
  onChange,
  width = 'w-32',
  dataAttr,
  placeholder = '请选择',
  ariaLabel,
}: {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange: (value: string) => void;
  width?: string;
  dataAttr?: string;
  placeholder?: string;
  /** 无障碍名称。视觉上旁边已经有文字标签时，读屏仍需要一个明确的名字。 */
  ariaLabel?: string;
}) {
  const rowLabelId = useContext(RowLabelContext);
  const menuId = useId();
  const optionId = (index: number) => `${menuId}-opt-${index}`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menu, setMenu] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });
  const current = options.find((option) => option.value === value) ?? null;
  const currentIndex = options.findIndex((option) => option.value === value);

  const openMenu = useCallback(() => {
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0);
    setOpen(true);
  }, [currentIndex]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) onChange(option.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange, options],
  );

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuWidth = Math.max(rect.width, 168);
    const left = Math.min(Math.max(4, rect.left), Math.max(4, window.innerWidth - menuWidth - 6));
    const spaceBelow = window.innerHeight - rect.bottom;
    // 下面不够放、且上面更宽敞 → 朝上弹。
    const up = spaceBelow < 180 && rect.top > spaceBelow;
    setMenu(
      up
        ? { left, width: menuWidth, bottom: Math.max(6, window.innerHeight - rect.top + 4) }
        : { left, width: menuWidth, top: rect.bottom + 4 },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // 点外面 / Esc → 收起。滚动不能「收起」，只能「重新定位」：
  // 按钮被点中时浏览器会把它滚动到可见区域（focus 触发 scrollIntoView），
  // 若滚动就关闭，菜单会在打开的同一帧被自己关掉——表现出来就是「点了没反应」。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (target.closest?.('[data-select-menu]')) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const reposition = () => place();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  // 键盘移到的选项要自己滚进可视区 —— 选项有 6 档语言等级、几十个时才看得见。
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = document.getElementById(optionId(activeIndex));
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, menuId]);

  /**
   * 触发器上的键盘处理。
   *
   * 焦点全程留在触发器（`aria-activedescendant` 报位置），这样 Esc 之后
   * 焦点天然还在原处，不会出现「关掉了但焦点不知道跑哪去了」。
   */
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;

    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openMenu();
      }
      return;
    }

    if (key === 'Escape' || key === 'Tab') {
      // Tab 不拦，让它按正常顺序离开；只把菜单收掉。
      setOpen(false);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }

    // 首字母跳转：连打同一个字母在候选里轮转，和原生 select 的行为一致。
    if (key.length === 1 && /\S/.test(key)) {
      const now = Date.now();
      const buffer = now - typeahead.current.at < 700 ? typeahead.current.buffer + key : key;
      typeahead.current = { buffer, at: now };
      const needle = buffer.toLowerCase();
      const hit = options.findIndex((option) => option.label.toLowerCase().startsWith(needle));
      if (hit >= 0) {
        event.preventDefault();
        setActiveIndex(hit);
      }
    }
  };

  const menuNode =
    open && menu
      ? createPortal(
          <div
            data-select-menu
            role="listbox"
            id={menuId}
            aria-label={ariaLabel ?? placeholder}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            style={{
              position: 'fixed',
              left: menu.left,
              width: menu.width,
              top: menu.top,
              bottom: menu.bottom,
              maxHeight: 264,
              zIndex: 9999,
            }}
            className="subtle-scroll no-drag overflow-y-auto rounded-lg border border-line bg-[#171a24] p-1 shadow-2xl shadow-black/70"
          >
            {options.map((option, index) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  id={optionId(index)}
                  aria-selected={active}
                  data-select-option={option.value}
                  data-select-active={index === activeIndex ? 'true' : 'false'}
                  onClick={() => commit(index)}
                  className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition ${
                    active ? 'bg-accent/20' : 'hover:bg-ink-700'
                  } ${index === activeIndex ? 'ring-1 ring-inset ring-accent/50' : ''}`}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className={`text-[11.5px] ${active ? 'text-white' : 'text-white/80'}`}>
                      {option.label}
                    </span>
                    {active && <span className="shrink-0 text-[10px] text-accent-soft">✓</span>}
                  </span>
                  {option.hint && (
                    <span className="mt-0.5 text-[9.5px] leading-tight text-white/35">
                      {option.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // 无障碍：这是一个下拉菜单的触发器，不是普通按钮。
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        /*
         * 焦点始终留在触发器上，位置靠 aria-activedescendant 播报。
         * 这一条必须挂在 combobox 上 —— 挂在 listbox 上没有读屏能读到
         * （listbox 本身不持有焦点），等于没做。
         */
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        /*
         * 名称来源优先级：调用点写的准确名字 > 同一行的文字标签 > 兜底文字。
         * 兜底以前是「请选择」，读屏界面上会出现一堆同名控件。
         */
        {...(ariaLabel
          ? { 'aria-label': ariaLabel }
          : rowLabelId
            ? { 'aria-labelledby': rowLabelId }
            : { 'aria-label': current?.label ?? placeholder })}
        onKeyDown={onTriggerKeyDown}
        // 不抢焦点：按钮获得焦点时浏览器可能把它滚进可视区，弹出层会跟着跳。
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : openMenu())}
        {...(dataAttr ? { [dataAttr]: '' } : {})}
        data-value={value}
        data-open={open ? 'true' : 'false'}
        className={`no-drag ${width} flex items-center justify-between gap-1 rounded-md border border-line-soft bg-[#14161f] px-2 py-1 text-[11px] text-white/90 transition hover:border-line-strong focus:border-accent/50 focus:outline-none`}
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder}</span>
        <span
          className={`shrink-0 text-[8px] text-white/40 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        >
          ▼
        </span>
      </button>
      {menuNode}
    </>
  );
}

export function Range({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Row label={format ? `${label} ${format(value)}` : label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        // 读屏软件默认只会念「滑块 3」，加上名称和当前值的文字才听得懂。
        aria-label={label}
        aria-valuetext={format ? format(value) : String(value)}
        aria-valuemin={min}
        aria-valuemax={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className="no-drag w-28 accent-accent"
      />
    </Row>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  dataAttr,
  full,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'ghost' | 'soft';
  disabled?: boolean;
  dataAttr?: string;
  full?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: 'bg-accent/85 text-white hover:bg-accent font-semibold',
    ghost: 'border border-line text-white/65 hover:bg-ink-700 hover:text-white',
    soft: 'bg-ink-800 text-white/75 hover:bg-white/12',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...(dataAttr ? { [dataAttr]: '' } : {})}
      className={`no-drag rounded-lg px-2.5 py-1 text-[11px] transition disabled:opacity-40 ${
        styles[variant]
      } ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

export function DeviceSelect({
  kind,
  value,
  onChange,
}: {
  kind: 'system' | 'mic';
  value: string;
  onChange: (value: string) => void;
}) {
  const [devices, setDevices] = useState<{ id: string; name: string; kind: string }[]>([]);

  useEffect(() => {
    window.copilot
      .audioDevices()
      .then((all) => setDevices(all.filter((device) => device.kind === kind)))
      .catch(() => setDevices([]));
  }, [kind]);

  // 复用自绘下拉：设备名可能有重名或很长，交给 Select 统一处理弹出与滚动。
  return (
    <Select
      value={value}
      /*
       * 两个设备下拉在同一页里长得一模一样，只靠同行的文字标签做名字，
       * 读屏连读两个「组合框」时根本分不出哪个是扬声器、哪个是麦克风。
       */
      ariaLabel={kind === 'system' ? '系统声音设备（对方的声音）' : '麦克风设备（你自己的声音）'}
      options={[
        { value: 'default', label: '默认设备' },
        ...devices.map((device) => ({ value: device.id, label: device.name.slice(0, 24) })),
      ]}
      onChange={onChange}
    />
  );
}
