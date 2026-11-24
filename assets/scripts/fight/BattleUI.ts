import {
    Color, Graphics, Label, Layers, Node, tween, UIOpacity, UITransform, Vec3,
} from 'cc';
import { CHARACTERS } from './BattleConfig';
import type { SkillDef } from './SkillTypes';
import { clamp, getViewport, Viewport } from './Viewport';

// ------------------------------------------------------------------ 布局常量
// 所有数值都是「设计单位」，720×1280 下与旧版坐标一致；实际坐标由 _layout() 按可视区换算。

/** 屏幕左右安全边距 */
const MARGIN_X = 20;
/** 顶部安全边距（叠加在设备安全区之上） */
const TOP_PAD = 20;
/** 底部安全边距 */
const BOTTOM_PAD = 10;

/** 顶部圆角按钮尺寸 */
const BTN_W = 84;
const BTN_H = 44;
/** 技能按钮高度 */
const SKILL_H = 84;
/** 能量条高度 */
const ENERGY_H = 16;
/** 战斗日志高度 */
const LOG_H = 148;

/** 能量条最大宽度 */
const ENERGY_W_MAX = 440;
/** 日志最大宽度 */
const LOG_W_MAX = 420;

// ------------------------------------------------------------------ 配色
const C_BG = '#0b1020';
const C_PANEL = '#161e30';
const C_PANEL_BORDER = '#3a4a66';
const C_TEXT = '#e8eefc';
const C_TEXT_DIM = '#93a4c0';
const C_BTN = '#233149';
const C_BTN_HOVER = '#2f4062';
const C_HEAL = '#5fd08a';

function hex (s: string): Color {
    const c = new Color();
    c.fromHEX(s);
    return c;
}

function makeNode (name: string, parent: Node, w: number, h: number): Node {
    const n = new Node(name);
    n.layer = Layers.Enum.UI_2D;
    n.addComponent(UITransform).setContentSize(w, h);
    n.setParent(parent);
    return n;
}

function setSize (n: Node, w: number, h: number): void {
    const ut = n.getComponent(UITransform);
    if (ut) ut.setContentSize(w, h);
}

// ------------------------------------------------------------------ 扁平按钮

interface BtnOpt {
    fontSize?: number;
    radius?: number;
    textColor?: Color;
    bg?: Color;
}

class FlatButton {
    public readonly node: Node;
    private readonly _g: Graphics;
    private readonly _label: Label;
    private readonly _w: number;
    private readonly _h: number;
    private readonly _r: number;
    private readonly _baseBg: Color;
    private _selected = false;
    private _enabled = true;

    constructor (
        parent: Node,
        text: string,
        w: number,
        h: number,
        x: number,
        y: number,
        onClick: () => void,
        opt: BtnOpt = {},
    ) {
        this._w = w;
        this._h = h;
        this._r = opt.radius ?? 10;
        this._baseBg = opt.bg ?? hex(C_BTN);

        this.node = makeNode('btn', parent, w, h);
        this.node.setPosition(x, y, 0);

        this._g = this.node.addComponent(Graphics);

        const labelNode = makeNode('label', this.node, w, h);
        this._label = labelNode.addComponent(Label);
        this._label.string = text;
        this._label.fontSize = opt.fontSize ?? 24;
        this._label.lineHeight = (opt.fontSize ?? 24) + 6;
        this._label.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._label.verticalAlign = Label.VerticalAlign.CENTER;
        this._label.overflow = Label.Overflow.NONE;
        this._label.color = opt.textColor ?? hex(C_TEXT);
        (this._label as any).isBold = true;

        this.node.on(Node.EventType.TOUCH_START, () => {
            if (!this._enabled) return;
            this._fill(this._selected ? this._baseBg : hex(C_BTN_HOVER));
        });
        this.node.on(Node.EventType.TOUCH_CANCEL, () => this.redraw());
        this.node.on(Node.EventType.TOUCH_END, () => {
            this.redraw();
            if (this._enabled) onClick();
        });

        this.redraw();
    }

    /** 布局时移动按钮（尺寸不变，避免重建子节点） */
    public setPos (x: number, y: number): void {
        this.node.setPosition(x, y, 0);
    }

    public setSelected (v: boolean): void {
        if (this._selected === v) return;
        this._selected = v;
        this.redraw();
    }

    public setEnabled (v: boolean): void {
        this._enabled = v;
        this._label.color = v ? hex(C_TEXT) : hex('#5a6a86');
        this.redraw();
    }

    public setText (t: string): void {
        this._label.string = t;
    }

    public redraw (): void {
        this._fill(this._selected ? hex('#3d6fa8') : this._baseBg);
    }

    private _fill (bg: Color): void {
        const g = this._g;
        g.clear();
        g.fillColor = bg;
        g.roundRect(-this._w / 2, -this._h / 2, this._w, this._h, this._r);
        g.fill();

        g.lineWidth = 2;
        g.strokeColor = this._selected ? hex('#7fc4ff') : (this._enabled ? hex(C_PANEL_BORDER) : hex('#2a3448'));
        g.roundRect(-this._w / 2, -this._h / 2, this._w, this._h, this._r);
        g.stroke();
    }
}

// ------------------------------------------------------------------ 技能按钮

/**
 * 技能键：按钮内容完全来自 skill.json
 * （短名、能量消耗、冷却时长、主题色都由 SkillDef 决定）
 */
class SkillButton {
    public readonly node: Node;
    public readonly skill: SkillDef;

    private readonly _g: Graphics;
    private readonly _nameLabel: Label;
    private readonly _costLabel: Label;
    private readonly _w: number;
    private readonly _h: number;
    private readonly _accent: Color;
    private _sig = '';

    constructor (
        parent: Node,
        skill: SkillDef,
        w: number,
        h: number,
        x: number,
        onClick: () => void,
    ) {
        this.skill = skill;
        this._w = w;
        this._h = h;
        this._accent = hex(skill.color);

        this.node = makeNode(`skill_${skill.id}`, parent, w, h);
        this.node.setPosition(x, 0, 0);
        this._g = this.node.addComponent(Graphics);

        const nameSize = w < 140 ? 20 : 24;
        const nameNode = makeNode('name', this.node, w, 34);
        nameNode.setPosition(0, 9, 0);
        this._nameLabel = nameNode.addComponent(Label);
        this._nameLabel.string = skill.short;
        this._nameLabel.fontSize = nameSize;
        this._nameLabel.lineHeight = nameSize + 6;
        this._nameLabel.color = hex(C_TEXT);
        this._nameLabel.overflow = Label.Overflow.NONE;
        (this._nameLabel as any).isBold = true;

        const costNode = makeNode('cost', this.node, w, 24);
        costNode.setPosition(0, -19, 0);
        this._costLabel = costNode.addComponent(Label);
        this._costLabel.fontSize = 16;
        this._costLabel.lineHeight = 20;
        this._costLabel.color = hex(C_TEXT_DIM);
        this._costLabel.overflow = Label.Overflow.NONE;

        this.node.on(Node.EventType.TOUCH_END, () => onClick());

        this.setState(false, skill.cooldown, false);
    }

    /** 更新状态；内部按签名去重，避免每帧重绘 */
    public setState (usable: boolean, cdLeft: number, enoughEnergy: boolean): void {
        const cd = Math.max(0, cdLeft);
        const sig = `${usable ? 1 : 0}|${Math.ceil(cd * 10)}|${enoughEnergy ? 1 : 0}`;
        if (sig === this._sig) return;
        this._sig = sig;

        const ratio = this.skill.cooldown > 0 ? Math.min(1, cd / this.skill.cooldown) : 0;
        this._draw(usable, ratio);
        this._nameLabel.color = usable ? hex(C_TEXT) : hex('#6b7a95');
        this._costLabel.color = enoughEnergy ? hex(C_TEXT_DIM) : hex('#8a5a66');
        this._costLabel.string = cd > 0.05
            ? `${cd.toFixed(1)}s`
            : (this.skill.type === 'heal' ? `治疗 ${this.skill.energyCost}` : `能量 ${this.skill.energyCost}`);
    }

    private _draw (usable: boolean, cdRatio: number): void {
        const g = this._g;
        const w = this._w;
        const h = this._h;
        g.clear();

        g.fillColor = usable ? hex(C_BTN) : hex('#141b29');
        g.roundRect(-w / 2, -h / 2, w, h, 12);
        g.fill();

        if (usable) {
            const tint = this._accent.clone();
            tint.a = 70;
            g.fillColor = tint;
            g.roundRect(-w / 2, -h / 2, w, h, 12);
            g.fill();
        }

        // 冷却遮罩：从底部升起
        if (cdRatio > 0.001) {
            g.fillColor = new Color(0, 0, 0, 150);
            g.rect(-w / 2, -h / 2, w, h * cdRatio);
            g.fill();
        }

        g.lineWidth = 2;
        g.strokeColor = usable ? this._accent : hex('#28324a');
        g.roundRect(-w / 2, -h / 2, w, h, 12);
        g.stroke();
    }
}

// ------------------------------------------------------------------ 下拉列表

interface DropdownItem {
    id: string;
    label: string;
}

/**
 * 纯 Graphics 下拉列表
 *
 * 触发框显示当前选项，点击后在面板上展开一个浮层。
 * 浮层挂在 panel 上并置顶，因此不会被同级元素遮挡。
 */
class Dropdown {
    public readonly node: Node;

    private readonly _g: Graphics;
    private readonly _label: Label;
    private readonly _panel: Node;
    private readonly _items: DropdownItem[];
    private readonly _w: number;
    private readonly _h: number;
    private readonly _onChange: (id: string) => void;
    private readonly _rowH = 54;

    private _value = '';
    private _list: Node | null = null;

    constructor (
        panel: Node,
        items: DropdownItem[],
        w: number,
        h: number,
        x: number,
        y: number,
        onChange: (id: string) => void,
    ) {
        this._panel = panel;
        this._items = items;
        this._w = w;
        this._h = h;
        this._onChange = onChange;

        this.node = makeNode('dd', panel, w, h);
        this.node.setPosition(x, y, 0);
        this._g = this.node.addComponent(Graphics);

        const tNode = makeNode('txt', this.node, w - 56, h);
        this._label = tNode.addComponent(Label);
        this._label.fontSize = 24;
        this._label.lineHeight = h;
        this._label.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._label.verticalAlign = Label.VerticalAlign.CENTER;
        this._label.overflow = Label.Overflow.CLAMP;
        this._label.color = hex(C_TEXT);
        tNode.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        tNode.setPosition(-w / 2 + 22, 0, 0);

        const arrow = makeNode('arrow', this.node, 40, h).addComponent(Label);
        arrow.string = '▾';
        arrow.fontSize = 24;
        arrow.lineHeight = h;
        arrow.color = hex(C_TEXT_DIM);
        arrow.node.setPosition(w / 2 - 26, 0, 0);

        this.node.on(Node.EventType.TOUCH_END, () => this._toggle());
        this._draw();
        if (items.length > 0) this.setValue(items[0].id);
    }

    public get value (): string {
        return this._value;
    }

    public setValue (id: string): void {
        const hit = this._items.find((i) => i.id === id);
        this._value = hit ? hit.id : (this._items[0]?.id ?? '');
        this._label.string = hit ? hit.label : (this._items[0]?.label ?? '');
    }

    public close (): void {
        if (this._list && this._list.isValid) this._list.destroy();
        this._list = null;
    }

    private _toggle (): void {
        if (this._list) {
            this.close();
            return;
        }
        this._open();
    }

    private _open (): void {
        const n = this._items.length;
        if (n === 0) return;

        // 角色池变多后单列会超出 640×860 的设置面板：超过 7 项自动改双列
        const cols = n > 7 ? 2 : 1;
        const rowH = cols === 2 ? 46 : this._rowH;
        const rows = Math.ceil(n / cols);
        const listH = rows * rowH;
        const cellW = this._w / cols;

        const list = makeNode('ddList', this._panel, this._w, listH);
        const p = this.node.position;

        // 默认向下展开；面板底部放不下时翻到触发框上方，仍放不下则贴底
        const panelH = this._panel.getComponent(UITransform)?.height ?? 0;
        const pad = 12;
        const bottom = -panelH / 2 + pad;
        let y = p.y - this._h / 2 - listH / 2 - 4;
        if (y - listH / 2 < bottom) {
            const up = p.y + this._h / 2 + listH / 2 + 4;
            y = (up + listH / 2 <= panelH / 2 - pad) ? up : bottom + listH / 2;
        }
        list.setPosition(p.x, y, 0);
        list.setSiblingIndex(this._panel.children.length - 1);

        const bg = list.addComponent(Graphics);
        bg.fillColor = hex('#0e1626');
        bg.roundRect(-this._w / 2, -listH / 2, this._w, listH, 10);
        bg.fill();
        bg.lineWidth = 2;
        bg.strokeColor = hex(C_PANEL_BORDER);
        bg.roundRect(-this._w / 2, -listH / 2, this._w, listH, 10);
        bg.stroke();
        // 双列时补一条分隔线
        if (cols === 2) {
            bg.lineWidth = 1;
            bg.strokeColor = hex(C_PANEL_BORDER);
            bg.moveTo(0, -listH / 2 + 10);
            bg.lineTo(0, listH / 2 - 10);
            bg.stroke();
        }

        this._items.forEach((it, i) => {
            // 按列优先排列：先填满第一列再填第二列，阅读顺序更自然
            const col = Math.floor(i / rows);
            const r = i % rows;

            const row = makeNode(`row_${it.id}`, list, cellW, rowH);
            row.setPosition(-this._w / 2 + cellW / 2 + col * cellW, listH / 2 - rowH / 2 - r * rowH, 0);

            if (it.id === this._value) {
                const rg = row.addComponent(Graphics);
                rg.fillColor = hex('#213a57');
                rg.roundRect(-cellW / 2 + 4, -rowH / 2 + 2, cellW - 8, rowH - 4, 8);
                rg.fill();
            }

            const tNode = makeNode('l', row, cellW - 40, rowH);
            const l = tNode.addComponent(Label);
            l.string = it.label;
            l.fontSize = 23;
            l.lineHeight = rowH;
            l.horizontalAlign = Label.HorizontalAlign.LEFT;
            l.verticalAlign = Label.VerticalAlign.CENTER;
            l.overflow = Label.Overflow.CLAMP;
            l.color = it.id === this._value ? hex('#cfe6ff') : hex(C_TEXT);
            tNode.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
            tNode.setPosition(-cellW / 2 + 20, 0, 0);

            row.on(Node.EventType.TOUCH_END, () => {
                const changed = this._value !== it.id;
                this.setValue(it.id);
                this.close();
                if (changed) this._onChange(it.id);
            });
        });

        this._list = list;
    }

    private _draw (): void {
        const w = this._w;
        const h = this._h;
        const g = this._g;
        g.clear();
        g.fillColor = hex('#1b2537');
        g.roundRect(-w / 2, -h / 2, w, h, 10);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = hex(C_PANEL_BORDER);
        g.roundRect(-w / 2, -h / 2, w, h, 10);
        g.stroke();
    }
}

// ------------------------------------------------------------------ 勾选框

/** 纯 Graphics 绘制的勾选框（带文字） */
class Checkbox {
    public readonly node: Node;

    private readonly _g: Graphics;
    private readonly _label: Label;
    private readonly _size: number;
    private readonly _onChange: (v: boolean) => void;
    private _checked: boolean;

    constructor (
        parent: Node,
        text: string,
        size: number,
        x: number,
        y: number,
        checked: boolean,
        onChange: (v: boolean) => void,
    ) {
        this._size = size;
        this._checked = checked;
        this._onChange = onChange;

        this.node = makeNode('cb', parent, 460, size + 14);
        this.node.setPosition(x, y, 0);

        const box = makeNode('box', this.node, size, size);
        box.setPosition(-230 + size / 2, 0, 0);
        this._g = box.addComponent(Graphics);

        const tNode = makeNode('t', this.node, 400, size + 10);
        this._label = tNode.addComponent(Label);
        this._label.string = text;
        this._label.fontSize = 22;
        this._label.lineHeight = size;
        this._label.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._label.verticalAlign = Label.VerticalAlign.CENTER;
        this._label.overflow = Label.Overflow.NONE;
        this._label.color = hex(C_TEXT);
        tNode.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        tNode.setPosition(-230 + size + 16, 0, 0);

        this.node.on(Node.EventType.TOUCH_END, () => this._toggle());
        this._draw();
    }

    public get checked (): boolean {
        return this._checked;
    }

    public setChecked (v: boolean, silent = true): void {
        if (this._checked === v) return;
        this._checked = v;
        this._draw();
        if (!silent) this._onChange(v);
    }

    private _toggle (): void {
        this._checked = !this._checked;
        this._draw();
        this._onChange(this._checked);
    }

    private _draw (): void {
        const s = this._size;
        const g = this._g;
        g.clear();

        g.fillColor = this._checked ? hex('#2a6fa8') : hex('#1b2537');
        g.roundRect(-s / 2, -s / 2, s, s, 8);
        g.fill();

        g.lineWidth = 2;
        g.strokeColor = this._checked ? hex('#7fc4ff') : hex(C_PANEL_BORDER);
        g.roundRect(-s / 2, -s / 2, s, s, 8);
        g.stroke();

        if (this._checked) {
            g.lineWidth = 4;
            g.strokeColor = hex('#ffffff');
            g.moveTo(-s * 0.26, 0);
            g.lineTo(-s * 0.06, -s * 0.2);
            g.lineTo(s * 0.28, s * 0.22);
            g.stroke();
        }
    }
}

// ------------------------------------------------------------------ 回调定义

export interface BattleUICallbacks {
    /** index 对应技能列表下标（skill1 → 0） */
    onSkill: (index: number) => void;
    onSpeedTap: () => void;
    /** 顶部/设置面板切换「循环战斗」 */
    onToggleLoop: (loop: boolean) => void;
    /** 顶部切换「自动释放技能」（只作用于左方 / 玩家） */
    onToggleAutoSkill: (on: boolean) => void;
    onOpenSettings: () => void;
    onCloseSettings: () => void;
    onRestart: () => void;
    /** 设置面板点击「开始战斗」；rightId 可能是 RANDOM_ENEMY */
    onApply: (leftId: string, rightId: string, speed: number, loop: boolean) => void;
}

/**
 * 战斗界面：血条、技能按钮、速度、日志、结算与设置面板。
 * 全部使用 Graphics + Label 绘制，不依赖任何图片资源。
 *
 * ★ 适配：所有坐标在 _layout() 中按当前可视区（viewport）换算。
 *   项目是 fitHeight（720×1280），高度恒定、宽度随设备变化，
 *   因此横向一律以 halfW 为基准，纵向以 halfH 为基准，并叠加设备安全区内缩。
 *   窗口尺寸变化时由 BattleManager 调用 relayout() 重新排布。
 */
export class BattleUI {
    public readonly root: Node;

    private _vp: Viewport;

    private readonly _cb: BattleUICallbacks;
    private readonly _floatLayer: Node;

    // 顶部
    private readonly _settingsBtn: FlatButton;
    private readonly _speedBtn: FlatButton;
    private readonly _loopBtn: FlatButton;
    private readonly _autoBtn: FlatButton;
    private readonly _title: Label;
    /** 连胜 / 当前第几场（循环模式才有值，-1 表示隐藏） */
    private readonly _streakLabel: Label;
    private _streak = -1;
    /** 循环开关的界面状态 */
    private _loopOn = false;
    /** 自动技能开关的界面状态 */
    private _autoOn = false;

    // 技能
    private readonly _skillBar: Node;
    private readonly _skillBtns: SkillButton[] = [];
    private _skills: SkillDef[] = [];

    // 能量
    private readonly _energyNode: Node;
    private readonly _skillEnergy: Graphics;
    private readonly _energyLabel: Label;
    private _energyW = ENERGY_W_MAX;
    private _energyValue = 0;

    // 日志
    private readonly _logNode: Node;
    private readonly _logLabel: Label;

    // 结算
    private readonly _resultMask: Node;
    private readonly _resultMaskG: Graphics;
    private readonly _resultPanel: Node;
    private readonly _resultTitle: Label;
    private readonly _resultSub: Label;

    // 设置
    private _settingMask!: Node;
    private _settingMaskG!: Graphics;
    private _settingPanel!: Node;
    private readonly _speedBtns: FlatButton[] = [];
    private _leftDd!: Dropdown;
    private _rightDd!: Dropdown;
    private _loopCb!: Checkbox;
    // 角色池由 GameConfig 在场景搭建前填充；这里的默认值只做兜底，
    // 保证配置加载失败时仍能构造出设置面板并显示错误
    private _selLeft = CHARACTERS.length > 0 ? CHARACTERS[0].id : '';
    /** 可能是具体角色 id，也可能是 'random' */
    private _selRight = CHARACTERS.length > 1 ? CHARACTERS[1].id : '';
    private _selSpeed = 1;
    private _selLoop = false;

    private readonly _logs: string[] = [];
    private _loading: Node | null = null;

    constructor (parent: Node, floatLayer: Node, cb: BattleUICallbacks) {
        this._cb = cb;
        this._floatLayer = floatLayer;
        this._vp = getViewport();

        this.root = makeNode('ui', parent, this._vp.width, this._vp.height);

        // ---- 顶部：设置 / 循环 / 自动 / 标题 / 速度 ----
        this._settingsBtn = new FlatButton(this.root, '设置', BTN_W, BTN_H, 0, 0, () => this._cb.onOpenSettings(), { fontSize: 21 });
        this._loopBtn = new FlatButton(this.root, '循环', BTN_W, BTN_H, 0, 0, () => {
            this.setLoopToggle(!this._loopOn);
            this._cb.onToggleLoop(this._loopOn);
        }, { fontSize: 21 });
        // 自动释放技能：只影响左方（玩家），关掉后回到纯手动
        this._autoBtn = new FlatButton(this.root, '自动', BTN_W, BTN_H, 0, 0, () => {
            this.setAutoSkillToggle(!this._autoOn);
            this._cb.onToggleAutoSkill(this._autoOn);
        }, { fontSize: 21 });
        this._speedBtn = new FlatButton(this.root, 'x1', BTN_W, BTN_H, 0, 0, () => this._cb.onSpeedTap(), { fontSize: 21 });
        this._title = makeNode('title', this.root, 400, BTN_H).addComponent(Label);
        this._title.string = '模拟战斗';
        this._title.fontSize = 26;
        this._title.lineHeight = BTN_H;
        this._title.color = hex(C_TEXT_DIM);
        this._title.verticalAlign = Label.VerticalAlign.CENTER;
        this._title.overflow = Label.Overflow.NONE;
        (this._title as any).isBold = true;

        // 连胜提示（循环模式显示，竖排紧跟标题下方）
        this._streakLabel = makeNode('streak', this.root, 320, 30).addComponent(Label);
        this._streakLabel.fontSize = 22;
        this._streakLabel.lineHeight = 26;
        this._streakLabel.color = hex('#ffd166');
        this._streakLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._streakLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this._streakLabel.overflow = Label.Overflow.NONE;
        (this._streakLabel as any).isBold = true;
        this._streakLabel.node.active = false;

        // ---- 技能栏（按钮由 skill.json 动态生成） ----
        this._skillBar = makeNode('skillBar', this.root, this._vp.width, SKILL_H);

        // ---- 能量条 ----
        this._energyNode = makeNode('energy', this.root, ENERGY_W_MAX, ENERGY_H);
        this._skillEnergy = this._energyNode.addComponent(Graphics);

        this._energyLabel = makeNode('energyText', this.root, ENERGY_W_MAX, 26).addComponent(Label);
        this._energyLabel.string = '能量 0 / 100';
        this._energyLabel.fontSize = 18;
        this._energyLabel.lineHeight = 22;
        this._energyLabel.color = hex(C_TEXT_DIM);
        this._energyLabel.overflow = Label.Overflow.NONE;

        // ---- 日志 ----
        this._logNode = makeNode('log', this.root, LOG_W_MAX, LOG_H);
        this._logNode.getComponent(UITransform)!.setAnchorPoint(0, 1);
        this._logLabel = this._logNode.addComponent(Label);
        this._logLabel.fontSize = 18;
        this._logLabel.lineHeight = 26;
        this._logLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        this._logLabel.verticalAlign = Label.VerticalAlign.TOP;
        // 窄屏时自动换行，超出部分裁切，不会盖住角色
        this._logLabel.overflow = Label.Overflow.CLAMP;
        this._logLabel.enableWrapText = true;
        this._logLabel.color = hex(C_TEXT_DIM);

        // ---- 结算面板 ----
        this._resultMask = makeNode('result', this.root, this._vp.width, this._vp.height);
        this._resultMask.addComponent(UIOpacity);
        this._resultMaskG = this._resultMask.addComponent(Graphics);

        this._resultPanel = makeNode('panel', this._resultMask, 560, 360);
        const rpG = this._resultPanel.addComponent(Graphics);
        rpG.fillColor = hex(C_PANEL);
        rpG.roundRect(-280, -180, 560, 360, 20);
        rpG.fill();
        rpG.lineWidth = 3;
        rpG.strokeColor = hex(C_PANEL_BORDER);
        rpG.roundRect(-280, -180, 560, 360, 20);
        rpG.stroke();

        this._resultTitle = makeNode('rtitle', this._resultPanel, 520, 70).addComponent(Label);
        this._resultTitle.fontSize = 46;
        this._resultTitle.lineHeight = 54;
        this._resultTitle.color = hex(C_TEXT);
        this._resultTitle.node.setPosition(0, 92, 0);
        (this._resultTitle as any).isBold = true;

        this._resultSub = makeNode('rsub', this._resultPanel, 520, 90).addComponent(Label);
        this._resultSub.fontSize = 24;
        this._resultSub.lineHeight = 36;
        this._resultSub.color = hex(C_TEXT_DIM);
        this._resultSub.node.setPosition(0, 6, 0);

        new FlatButton(this._resultPanel, '再来一局', 240, 66, 0, -110, () => this._cb.onRestart(), { fontSize: 28, radius: 12 });

        this._resultMask.active = false;

        // ---- 设置面板 ----
        this._buildSettingPanel();
        this._settingMask.active = false;

        // ---- 统一排布 ----
        this._layout();
    }

    // ---------------------------------------------------------------- 适配

    /**
     * 按当前可视区重新排布全部元素。
     * 窗口缩放 / 横竖屏切换 / 浏览器地址栏收起时由 BattleManager 调用。
     */
    public relayout (): void {
        this._layout();
    }

    private _layout (): void {
        const vp = this._vp = getViewport();
        const W = vp.width;
        const H = vp.height;
        const halfW = vp.halfW;
        const halfH = vp.halfH;
        const s = vp.safe;

        // 可用矩形（已避让刘海与圆角）
        const leftEdge = -halfW + s.left + MARGIN_X;
        const rightEdge = halfW - s.right - MARGIN_X;
        const usableW = rightEdge - leftEdge;
        const usableH = H - s.top - s.bottom;

        setSize(this.root, W, H);

        // ---------------- 顶部一行：设置 / 循环 / 自动 / 标题 / 速度 ----------------
        const topY = halfH - s.top - TOP_PAD - BTN_H / 2;
        const btnGap = 8;
        this._settingsBtn.setPos(leftEdge + BTN_W / 2, topY);
        this._loopBtn.setPos(leftEdge + BTN_W * 1.5 + btnGap, topY);
        this._autoBtn.setPos(leftEdge + BTN_W * 2.5 + btnGap * 2, topY);
        this._speedBtn.setPos(rightEdge - BTN_W / 2, topY);

        // 标题可用的横向区间（左右避让按钮，精确不重叠）
        const tLeft = leftEdge + BTN_W * 3 + btnGap * 2 + 12;
        const tRight = rightEdge - BTN_W - 12;
        const titleAvail = Math.max(100, tRight - tLeft);
        const titleCx = (tLeft + tRight) / 2;

        const tNode = this._title.node;
        setSize(tNode, titleAvail, BTN_H);
        tNode.setPosition(titleCx, topY, 0);
        if (titleAvail >= 380) {
            this._title.string = '模拟战斗';
            this._title.fontSize = 26;
        } 
        this._title.lineHeight = BTN_H;

        // 连胜提示挂在标题下方（循环模式才显示）
        setSize(this._streakLabel.node, titleAvail, 30);
        this._streakLabel.node.setPosition(titleCx, topY - BTN_H / 2 - 16, 0);

        // ---------------- 底部：技能栏 / 能量 / 日志 ----------------
        const skillY = -halfH + s.bottom + BOTTOM_PAD + SKILL_H / 2;
        setSize(this._skillBar, W, SKILL_H);
        this._skillBar.setPosition(0, skillY, 0);

        const energyY = skillY + SKILL_H / 2 + 30;
        this._energyW = clamp(usableW - 40, 160, ENERGY_W_MAX);
        setSize(this._energyNode, this._energyW, ENERGY_H);
        this._energyNode.setPosition(0, energyY, 0);
        this._redrawEnergy(this._energyValue);

        setSize(this._energyLabel.node, this._energyW, 26);
        this._energyLabel.node.setPosition(0, energyY + 22, 0);

        const logBottom = energyY + 22 + 26;
        const logW = clamp(usableW * 0.72, 200, LOG_W_MAX);
        // 日志高度固定，始终完全位于技能栏上方，不与之重叠
        const logH = Math.min(LOG_H, Math.max(96, usableH * 0.12));
        setSize(this._logNode, logW, logH);
        this._logNode.setPosition(leftEdge, logBottom + logH, 0);

        // ---------------- 结算 / 设置遮罩 ----------------
        this._layoutMask(this._resultMask, this._resultMaskG, W, H);
        this._resultPanel.setPosition(0, 0, 0);
        const rs = Math.min(1, usableW / 580, (H - s.top - s.bottom - 80) / 360);
        this._resultPanel.setScale(rs, rs, 1);

        this._layoutMask(this._settingMask, this._settingMaskG, W, H);
        this._settingPanel.setPosition(0, 0, 0);
        const ss = Math.min(1, usableW / 640, (H - s.top - s.bottom - 60) / 860);
        this._settingPanel.setScale(ss, ss, 1);

        // 加载提示
        if (this._loading) {
            setSize(this._loading, W, 100);
            this._loading.setPosition(0, halfH * 0.1, 0);
        }

        // 技能按钮按新宽度重排（重建，数量与宽度都可能变化）
        if (this._skills.length > 0) this.setSkills(this._skills);
    }

    private _layoutMask (mask: Node, g: Graphics, w: number, h: number): void {
        setSize(mask, w, h);
        mask.setPosition(0, 0, 0);
        g.clear();
        g.fillColor = new Color(0, 0, 0, mask === this._resultMask ? 170 : 190);
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();
    }

    // ---------------------------------------------------------------- 对外接口

    /** 换场：同步技能栏与能量（血条由角色头顶自己维护） */
    public setFighters (leftId: string, _rightId: string): void {
        const l = CHARACTERS.find((c) => c.id === leftId) ?? CHARACTERS[0];
        this.setSkills(l ? l.skills : []);
        this.setEnergy(0);
    }

    /** 配置加载完成后，同步设置面板里的角色名（下拉项在构建时已按 CHARACTERS 生成） */
    public refreshCharacterNames (): void {
        // 下拉列表的文案来自 CHARACTERS，无需逐项刷新；
        // 保留此方法以兼容 BattleManager 的调用时序。
    }

    /** 循环开关的界面状态（由 BattleManager 回写） */
    public setLoopToggle (on: boolean): void {
        this._loopOn = on;
        this._loopBtn.setSelected(on);
        this._loopCb?.setChecked(on);
        this._selLoop = on;
    }

    /** 自动技能开关的界面状态（由 BattleManager 回写） */
    public setAutoSkillToggle (on: boolean): void {
        this._autoOn = on;
        this._autoBtn.setSelected(on);
    }

    /** 连胜 / 场次提示；传负数表示隐藏 */
    public setStreak (n: number): void {
        this._streak = n;
        const show = n >= 0;
        this._streakLabel.node.active = show;
        if (!show) {
            this._streakLabel.string = '';
        } else if (n === 0) {
            this._streakLabel.string = '循环战斗中';
        } else {
            this._streakLabel.string = `连胜 ${n} 场`;
        }
    }

    /** 按当前左方（玩家）角色的技能列表重建技能栏（宽度随屏幕自适应） */
    public setSkills (skills: SkillDef[]): void {
        this._skills = skills;
        for (const b of this._skillBtns) {
            if (b.node.isValid) b.node.destroy();
        }
        this._skillBtns.length = 0;

        const n = skills.length;
        if (n === 0) return;

        const vp = this._vp;
        const avail = clamp(vp.width - vp.safe.left - vp.safe.right - MARGIN_X * 2, 240, 660);
        const gap = n >= 4 ? 10 : 12;
        const maxW = n <= 2 ? 200 : (n === 3 ? 178 : 156);
        const w = Math.floor(Math.min(maxW, (avail - (n - 1) * gap) / n));
        const total = n * w + (n - 1) * gap;
        const startX = -total / 2 + w / 2;

        skills.forEach((skill, i) => {
            const btn = new SkillButton(
                this._skillBar,
                skill,
                w,
                SKILL_H,
                startX + i * (w + gap),
                () => this._cb.onSkill(i),
            );
            this._skillBtns.push(btn);
        });
    }

    /** 由 BattleManager 每帧驱动，刷新技能键的可用态与冷却 */
    public updateSkills (states: { usable: boolean; cooldown: number; enoughEnergy: boolean }[]): void {
        for (let i = 0; i < this._skillBtns.length; i++) {
            const s = states[i];
            if (!s) continue;
            this._skillBtns[i].setState(s.usable, s.cooldown, s.enoughEnergy);
        }
    }

    public setEnergy (v: number): void {
        this._energyValue = v;
        this._redrawEnergy(v);
        this._energyLabel.string = `能量 ${Math.floor(v)} / 100`;
        this._energyLabel.color = v >= 100 ? hex(C_HEAL) : hex(C_TEXT_DIM);
    }

    public setSpeedLabel (speed: number): void {
        this._speedBtn.setText(speed === 0.5 ? 'x0.5' : `x${speed}`);
    }

    public log (msg: string): void {
        this._logs.push(msg);
        while (this._logs.length > 5) this._logs.shift();
        this._logLabel.string = this._logs.join('\n');
    }

    public clearLog (): void {
        this._logs.length = 0;
        this._logLabel.string = '';
    }

    /** 伤害飘字（坐标位于 stage 坐标系） */
    public float (pos: Vec3, text: string, color: Color, big = false): void {
        const node = makeNode('float', this._floatLayer, 220, 50);
        node.setPosition(pos.x + (Math.random() * 40 - 20), pos.y, 0);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = big ? 46 : 32;
        label.lineHeight = big ? 54 : 40;
        label.color = color;
        label.overflow = Label.Overflow.NONE;
        (label as any).isBold = true;

        const op = node.addComponent(UIOpacity);
        node.setScale(0.6, 0.6, 1);
        tween(node).to(0.12, { scale: new Vec3(1.15, 1.15, 1) }).to(0.1, { scale: new Vec3(1, 1, 1) }).start();
        tween(op).delay(0.5).to(0.4, { opacity: 0 }).start();
        tween(node)
            .by(0.9, { position: new Vec3(0, 96, 0) }, { easing: 'quadOut' })
            .call(() => { if (node.isValid) node.destroy(); })
            .start();
    }

    public showResult (title: string, sub: string, color: Color): void {
        this._resultTitle.string = title;
        this._resultTitle.color = color;
        this._resultSub.string = sub;
        this._resultMask.active = true;
        const op = this._resultMask.getComponent(UIOpacity)!;
        op.opacity = 0;
        tween(op).to(0.25, { opacity: 255 }).start();
    }

    public hideResult (): void {
        this._resultMask.active = false;
    }

    public setLoading (text: string): void {
        if (!this._loading) {
            this._loading = makeNode('loading', this.root, this._vp.width, 100);
            this._loading.setPosition(0, this._vp.halfH * 0.1, 0);
            const l = this._loading.addComponent(Label);
            l.fontSize = 28;
            l.lineHeight = 36;
            l.horizontalAlign = Label.HorizontalAlign.CENTER;
            l.verticalAlign = Label.VerticalAlign.CENTER;
            l.color = hex(C_TEXT);
        }
        this._loading.getComponent(Label)!.string = text;
        this._loading.active = text !== '';
    }

    // ---------------------------------------------------------------- 设置面板

    public openSettings (leftId: string, rightId: string, speed: number, loop: boolean): void {
        this._selLeft = leftId;
        this._selRight = rightId;
        this._selSpeed = speed;
        this._selLoop = loop;
        this._leftDd.setValue(leftId);
        this._rightDd.setValue(rightId);
        this._loopCb.setChecked(loop);
        this._syncSettingSelection();
        this._settingMask.active = true;
    }

    public closeSettings (): void {
        // 收起可能仍在展开的下拉浮层，避免下次打开时残留
        this._leftDd.close();
        this._rightDd.close();
        this._settingMask.active = false;
    }

    // ---------------------------------------------------------------- 内部

    private _buildSettingPanel (): void {
        const mask = makeNode('settings', this.root, this._vp.width, this._vp.height);
        this._settingMask = mask;
        this._settingMaskG = mask.addComponent(Graphics);
        // 拦截穿透点击
        mask.on(Node.EventType.TOUCH_END, () => { /* 吞掉事件 */ });

        const panel = makeNode('panel', mask, 640, 860);
        this._settingPanel = panel;
        const pg = panel.addComponent(Graphics);
        pg.fillColor = hex(C_PANEL);
        pg.roundRect(-320, -430, 640, 860, 22);
        pg.fill();
        pg.lineWidth = 3;
        pg.strokeColor = hex(C_PANEL_BORDER);
        pg.roundRect(-320, -430, 640, 860, 22);
        pg.stroke();

        const title = makeNode('t', panel, 600, 50).addComponent(Label);
        title.string = '战斗设置';
        title.fontSize = 34;
        title.lineHeight = 42;
        title.color = hex(C_TEXT);
        (title as any).isBold = true;
        title.node.setPosition(0, 372, 0);

        // --- 速度 ---
        this._sectionLabel(panel, '战斗速度', 306);
        const speeds = [0.5, 1, 2, 3];
        speeds.forEach((s, i) => {
            const btn = new FlatButton(panel, s === 0.5 ? 'x0.5' : `x${s}`, 128, 54, -234 + i * 156, 246, () => {
                this._selSpeed = s;
                this._syncSettingSelection();
            }, { fontSize: 24 });
            this._speedBtns.push(btn);
        });

        // --- 左方角色（下拉） ---
        this._sectionLabel(panel, '左方角色（主角）', 178);
        this._leftDd = new Dropdown(
            panel,
            CHARACTERS.map((c) => ({ id: c.id, label: c.name })),
            520,
            62,
            0,
            118,
            (id) => { this._selLeft = id; },
        );

        // --- 右方角色（下拉，多一个「随机」） ---
        this._sectionLabel(panel, '右方角色（敌人）', 42);
        const rightItems: DropdownItem[] = [
            { id: 'random', label: '随机（每场重抽）' },
            ...CHARACTERS.map((c) => ({ id: c.id, label: c.name })),
        ];
        this._rightDd = new Dropdown(
            panel,
            rightItems,
            520,
            62,
            0,
            -18,
            (id) => { this._selRight = id; },
        );

        // --- 循环战斗 ---
        this._loopCb = new Checkbox(
            panel,
            '循环战斗（击杀后自动续战）',
            34,
            -50,
            -104,
            false,
            (v) => {
                this._selLoop = v;
                this._cb.onToggleLoop(v);
            },
        );

        new FlatButton(panel, '开始战斗', 280, 72, 0, -236, () => {
            this.closeSettings();
            this._cb.onApply(this._selLeft, this._selRight, this._selSpeed, this._selLoop);
        }, { fontSize: 30, radius: 14, bg: hex('#25687f') });

        new FlatButton(panel, '关闭', 160, 52, 0, -344, () => this._cb.onCloseSettings(), { fontSize: 22 });
    }

    private _sectionLabel (parent: Node, text: string, y: number): void {
        const n = makeNode('sec', parent, 560, 34);
        const l = n.addComponent(Label);
        l.string = text;
        l.fontSize = 22;
        l.lineHeight = 28;
        l.color = hex(C_TEXT_DIM);
        l.horizontalAlign = Label.HorizontalAlign.LEFT;
        n.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        n.setPosition(-270, y, 0);
    }

    private _syncSettingSelection (): void {
        [0.5, 1, 2, 3].forEach((s, i) => this._speedBtns[i].setSelected(this._selSpeed === s));
        this._leftDd?.setValue(this._selLeft);
        this._rightDd?.setValue(this._selRight);
        this._loopCb?.setChecked(this._selLoop);
    }


    private _redrawEnergy (v: number): void {
        const g = this._skillEnergy;
        const w = this._energyW;
        const h = ENERGY_H;
        g.clear();
        g.fillColor = hex(C_BG);
        g.roundRect(-w / 2, -h / 2, w, h, h / 2);
        g.fill();
        const filled = Math.max(0, Math.min(1, v / 100)) * (w - 6);
        if (filled > 1) {
            g.fillColor = v >= 100 ? hex(C_HEAL) : hex('#4a7fd0');
            g.roundRect(-w / 2 + 3, -h / 2 + 3, filled, h - 6, (h - 6) / 2);
            g.fill();
        }
        g.lineWidth = 2;
        g.strokeColor = hex(C_PANEL_BORDER);
        g.roundRect(-w / 2, -h / 2, w, h, h / 2);
        g.stroke();
    }
}
