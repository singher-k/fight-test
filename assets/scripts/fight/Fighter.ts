import {
    Color, Graphics, Label, Layers, Node, Tween, tween, UIOpacity, UITransform, sp,
} from 'cc';
import { AttackAnim, BATTLE, CharacterConfig } from './BattleConfig';
import type { BuffDef, BuffInstance, BuffStats } from './BuffTypes';
import type { SkillDef } from './SkillTypes';

export enum FighterState {
    Idle = 'idle',
    /** 走位（播放 run 动画） */
    Move = 'move',
    Attack = 'attack',
    Skill = 'skill',
    Hurt = 'hurt',
    Dead = 'dead',
}

/**
 * 单个战斗单位
 *
 * 负责：Spine 节点的创建与缩放、朝向、**世界坐标移动**、动作播放与计时、
 * 受击表现、死亡演出、**头顶血条**。
 * 数值结算与战斗流程编排交给 BattleManager。
 *
 * ★ 位置模型
 *   - `x` 是逻辑坐标（战斗世界的横向坐标），移动只改它；
 *   - 每帧由 `_syncPos()` 把 `x + _pushOff * facing`（击退偏移）与 `_airY`
 *     （击飞高度）写进节点位置，因此位移不会被 Tween 与逐帧移动互相覆盖；
 *   - 普攻 / 技能都**不做**前冲位移，横向位移只来自 buff 的击退（side view 下
 *     任何主动前冲都会被读成「人物左右晃动」）。
 */
export class Fighter {
    public readonly cfg: CharacterConfig;
    /** 角色根节点（用于位移 / 震屏 / 死亡倒下） */
    public readonly node: Node;
    public readonly spine: sp.Skeleton;

    public hp: number;
    public energy = 0;
    public state: FighterState = FighterState.Idle;
    /** 距离下一次普攻的冷却（战斗时间秒） */
    public cooldown = 0;

    /** 当前朝向，1 = 朝右，-1 = 朝左 */
    public facing: 1 | -1;
    /** 当前世界坐标 X（横轴唯一的位置来源） */
    public x = 0;
    /** 脚底所在的父节点坐标 Y */
    public baseY: number;

    private readonly _flip: Node;
    /** 资源自身朝向修正：1 = 原生朝右，-1 = 原生朝左（spine.json 的 flip） */
    private readonly _baseFlip: 1 | -1;
    private readonly _opacity: UIOpacity;
    private _headY: number;
    /** 屏幕适配后的实际缩放（= cfg.displayScale × 全局系数） */
    private _scale: number;
    /** 全局适配系数（屏幕适配 × BATTLE.characterScale） */
    private _gscale: number;

    // ---- 走位 ----
    /** 移动目标；null 表示不在移动 */
    private _walkTarget: number | null = null;
    private _walkSpeed = 0;

    // ---- 前冲 / 击退（沿朝向的一次性偏移，两端归零） ----
    private _pushDist = 0;
    private _pushT = 0;
    private _pushDur = 0;
    private _pushOff = 0;

    // ---- 动画时序 ----
    private _timer = 0;
    private _endAt = -1;
    /** 各段命中的绝对时刻（秒），一个技能可以有多段 */
    private _hitAts: number[] = [];
    private _hitIndex = 0;
    private _onHit: ((index: number) => void) | null = null;
    private _onEnd: (() => void) | null = null;

    // ---- 延迟应用（WASM 骨架可能尚未就绪） ----
    private _pendingName = '';
    private _pendingLoop = true;
    /** 目标演出时长（秒）；0 表示按动画原速 */
    private _pendingTarget = 0;
    private _pendingToken = 0;
    private _appliedToken = -1;

    // ---- 闪白 ----
    private _flashLeft = 0;

    /**
     * 战斗倍速
     *
     * 战斗逻辑按「真实 dt × 倍速」推进，而 sp.Skeleton 按真实时间 × timeScale 推进。
     * 不把倍速乘进 timeScale 的话，x2 / x3 时逻辑已经切到下一个动作，
     * 动画才播到一半 —— 表现就是「技能没放完」。
     */
    private _speedScale = 1;

    // ---- buff（技能打击点施加的效果，全部走这里） ----
    /** 身上的 buff 实例 */
    private _buffs: BuffInstance[] = [];
    /**
     * 结算回调：周期跳伤 / 跳治疗 / 瞬时伤害 / 到期结算都从这里回到 BattleManager
     *
     * Fighter 只负责「什么时候该结算」，扣血、飘字、判胜负都在 BattleManager 里做，
     * 避免 Fighter 反向依赖战斗流程。
     */
    public onBuffResolve: ((owner: Fighter, inst: BuffInstance) => void) | null = null;

    // ---- 击飞（垂直方向的抛物线，与横向前冲独立） ----
    private _airH = 0;
    private _airT = 0;
    private _airDur = 0;
    private _airY = 0;

    // ---- 头顶血条 ----
    private _barNode: Node = null!;
    private _barG: Graphics = null!;
    private _barValue: Label = null!;
    private _barName: Label = null!;
    private _barW = 0;
    private _barH = 0;
    private _barAccent: Color;
    private _hpRatio = 1;
    private _hpTarget = 1;
    private _barDirty = true;

    // ---- 初始化重试 ----
    private _retryCount = 0;
    private _alphaFixed = false;

    /**
     * @param groundY 脚底所在的父节点坐标 Y（由屏幕适配决定）
     * @param globalScale 全局缩放系数（屏幕适配 × BATTLE.characterScale），会乘到 cfg.displayScale 上
     */
    constructor (
        parent: Node,
        cfg: CharacterConfig,
        data: sp.SkeletonData,
        facing: 1 | -1,
        groundY: number,
        globalScale = 1,
    ) {
        this.cfg = cfg;
        this.facing = facing;
        this.hp = cfg.maxHp;
        this._barAccent = new Color();
        this._barAccent.fromHEX(cfg.accent || '#7fd4ff');

        this._gscale = globalScale;
        const scale = cfg.displayScale * globalScale;
        this._scale = scale;
        this.baseY = groundY;
        // 头顶 = 地面 + (头顶 - 锚点) * 缩放
        this._headY = groundY + (cfg.headY - cfg.anchorY) * scale;

        this.node = new Node(`Fighter_${cfg.id}`);
        this.node.layer = Layers.Enum.UI_2D;
        this.node.addComponent(UITransform);
        this.node.setParent(parent);

        this._opacity = this.node.addComponent(UIOpacity);

        // 朝向由独立的翻转层承担，避免与缩放 / 死亡旋转互相干扰。
        // 翻转层同时承担「资源朝向修正」：部分外包骨骼原生朝左（cfg.flipX），
        // 这里统一换算成世界朝向，上层只管 facing = 1/-1。
        this._baseFlip = cfg.flipX ? -1 : 1;
        this._flip = new Node('flip');
        this._flip.layer = Layers.Enum.UI_2D;
        this._flip.addComponent(UITransform);
        this._flip.setParent(this.node);
        this._flip.setScale(facing * this._baseFlip, 1, 1);
        // 微调放在翻转层上，语义是「屏幕方向」，翻转后不会左右倒过来
        this._flip.setPosition(cfg.offsetX, cfg.offsetY, 0);

        const spineNode = new Node('spine');
        spineNode.layer = Layers.Enum.UI_2D;
        spineNode.addComponent(UITransform);
        this.spine = spineNode.addComponent(sp.Skeleton);
        spineNode.setParent(this._flip);
        spineNode.setScale(scale, scale, 1);
        // 把骨架内的 anchor 点（默认取脚底中心）平移到节点原点，
        // 使所有角色共用同一个对齐基准：节点原点 = 脚底中心。
        // 翻转层是以脚底中心为轴镜像的，所以 flipX 为真时锚点自动对称，无需改 anchorX。
        spineNode.setPosition(-cfg.anchorX * scale, -cfg.anchorY * scale, 0);

        this._buildHeadBar();

        this.spine.skeletonData = data;
        // premultipliedAlpha 在骨架就绪后由 _applyPending 设置，避免访问未初始化的实例
        this.playIdle();
    }

    // ---------------------------------------------------------------- 查询

    public get alive (): boolean {
        return this.hp > 0;
    }

    /** 角色头顶在父节点坐标系中的 Y（用于飘字定位） */
    public get headY (): number {
        return this._headY;
    }

    /** 当前横向缩放（显示用） */
    public get scaleFactor (): number {
        return this._scale;
    }

    /** 普攻射程（已按屏幕缩放换算，世界坐标单位） */
    public get attackRange (): number {
        return Math.max(40, this.cfg.attackRange * this._gscale);
    }

    /**
     * 移动速度（已按屏幕缩放换算，世界单位/秒）
     *
     * 含 buff 的移速百分比：减速 40% 时这里直接变小，走位与追击都用它。
     */
    public get moveSpeed (): number {
        return Math.max(20, this.cfg.moveSpeed * (1 + this.statSum('moveSpeed')) * this._gscale);
    }

    /** 攻击力（含 buff 加成；伤害结算一律读这个，不要读 cfg.atk） */
    public get atk (): number {
        return Math.max(1, this.cfg.atk * (1 + this.statSum('atk')));
    }

    /** 防御力（含 buff 加成；减伤结算读这个） */
    public get def (): number {
        return Math.max(0, this.cfg.def * (1 + this.statSum('def')));
    }

    /** 暴击率（含 buff 加成，钳在 0~1） */
    public get critRate (): number {
        return Math.max(0, Math.min(1, this.cfg.critRate + this.statSum('critRate')));
    }

    /** 当前所有 buff 的只读快照（调试 / 后续做图标用） */
    public get buffs (): readonly BuffInstance[] {
        return this._buffs;
    }

    /** 是否被眩晕（完全无法行动） */
    public get stunned (): boolean {
        return this.hasControl('stun');
    }

    /** 能否普攻与主动走位（眩晕时不行） */
    public get canAct (): boolean {
        return !this.hasControl('stun');
    }

    /** 能否移动（眩晕、定身都不行） */
    public get canMove (): boolean {
        return !this.hasControl('stun') && !this.hasControl('root');
    }

    /** 能否释放技能（眩晕、沉默都不行） */
    public get canCast (): boolean {
        return !this.hasControl('stun') && !this.hasControl('silence');
    }

    /** 某个属性上的 buff 百分比总和（0.3 = +30%） */
    public statSum (key: keyof BuffStats): number {
        let sum = 0;
        for (const b of this._buffs) {
            const v = b.def.stats[key];
            if (v) sum += v * b.stacks;
        }
        return sum;
    }

    /** 是否带有某种控制 */
    public hasControl (kind: 'stun' | 'root' | 'silence'): boolean {
        for (const b of this._buffs) {
            if (b.def.control === kind && b.remain > 0) return true;
        }
        return false;
    }

    /** 是否正在走位 */
    public get moving (): boolean {
        return this._walkTarget !== null;
    }

    /** 到另一个单位的横向距离 */
    public distanceTo (other: Fighter): number {
        return Math.abs(this.x - other.x);
    }

    /** 该技能的实际射程：技能填了 range 就覆盖，否则用角色射程 */
    public rangeOf (def: SkillDef | null): number {
        if (def && def.range > 0) return Math.max(40, def.range * this._gscale);
        return this.attackRange;
    }

    // ---------------------------------------------------------------- 位置

    /** 立即放到指定世界坐标（初始化 / 换位用），会打断走位 */
    public placeAt (x: number): void {
        this.x = x;
        this._walkTarget = null;
        this._pushDur = 0;
        this._pushOff = 0;
        this._syncPos();
    }

    public setFacing (f: 1 | -1): void {
        if (this.facing === f) return;
        this.facing = f;
        this._flip.setScale(f * this._baseFlip, 1, 1);
    }

    /**
     * 同步战斗倍速（每帧由 BattleManager 写入，值未变时直接返回）
     *
     * 正在播放时立即重算 timeScale，这样中途切倍速也不会出现动作与逻辑错位。
     */
    public setSpeedScale (k: number): void {
        const s = k > 0 ? k : 1;
        if (Math.abs(s - this._speedScale) < 0.001) return;
        this._speedScale = s;
        if (this.spine && this.spine.isValid) {
            this.spine.timeScale = this._computeTimeScale() * this._speedScale;
        }
    }

    /**
     * 朝目标 X 走位
     * @param targetX 目标世界坐标
     * @param speed 速度（世界单位/秒）；不传则用角色自身移速
     * @param allowApproach 允许的最小间距（避免走到目标身上）
     */
    public walkTo (targetX: number, speed?: number, allowApproach = 0): void {
        if (this.state === FighterState.Dead) return;
        // 出手中 / 受击中不接受新的走位指令
        if (this.state !== FighterState.Idle && this.state !== FighterState.Move) return;

        let tx = targetX;
        if (allowApproach > 0) {
            const d = targetX - this.x;
            if (Math.abs(d) <= allowApproach) {
                this.stopWalk();
                return;
            }
            tx = targetX - Math.sign(d) * allowApproach;
        }

        if (Math.abs(tx - this.x) < 1) {
            this.stopWalk();
            return;
        }

        const wasMoving = this.state === FighterState.Move;
        this._walkTarget = tx;
        this._walkSpeed = Math.max(20, speed ?? this.moveSpeed);
        this.setFacing(tx > this.x ? 1 : -1);

        // 已经在走就只更新目标，避免每帧重置动画出现「走-停」闪烁
        if (!wasMoving) {
            this.state = FighterState.Move;
            this._endAt = -1;
            this._hitAts.length = 0;
            this._hitIndex = 0;
            this._onHit = null;
            this._onEnd = null;
            // run 缺失时退回待机，避免骨架里没有该动画导致黑屏
            this._queue(this.cfg.run || this.cfg.idle, true, 0);
        }
    }

    public stopWalk (): void {
        if (this._walkTarget === null) return;
        this._walkTarget = null;
        if (this.state === FighterState.Move) this.playIdle();
    }

    /**
     * 屏幕尺寸变化后重新下发地面高度与缩放。
     * 横向位置保持不变（世界坐标由 BattleManager 决定）。
     */
    public applyLayout (groundY: number, globalScale: number): void {
        this._gscale = globalScale;
        this.baseY = groundY;

        const scale = this.cfg.displayScale * globalScale;
        if (Math.abs(scale - this._scale) > 0.0005) {
            this._scale = scale;
            this.spine.node.setScale(scale, scale, 1);
            this.spine.node.setPosition(
                -this.cfg.anchorX * scale,
                -this.cfg.anchorY * scale,
                0,
            );
        }
        this._headY = groundY + (this.cfg.headY - this.cfg.anchorY) * scale;

        this._layoutHeadBar();
        this._barDirty = true;
        this._syncPos();
    }

    public setX (x: number): void {
        this.x = x;
        this._syncPos();
    }

    // ---------------------------------------------------------------- 动作

    public playIdle (): void {
        if (this.state === FighterState.Dead) return;
        this.state = FighterState.Idle;
        this._walkTarget = null;
        this._endAt = -1;
        this._timer = 0;
        this._hitAts.length = 0;
        this._hitIndex = 0;
        this._onHit = null;
        this._onEnd = null;
        this._queue(this.cfg.idle, true, 0);
    }

    /**
     * 普通攻击
     * @param anim 动作与原始时长
     * @param targetDuration 期望播完的时长（决定播放倍速）
     */
    public playAttack (
        anim: AttackAnim,
        targetDuration: number,
        onHit: () => void,
        onEnd: () => void,
    ): void {
        if (this.state === FighterState.Dead) return;
        this._walkTarget = null;
        this.state = FighterState.Attack;
        this._runTimed(anim.name, targetDuration, [BATTLE.hitProgress], onHit, onEnd);
        // 普攻不做前冲位移：横向位移在侧视角下会被读成「人物左右晃动」。
        // 需要恢复时补一行 this._startPush(46, 0.3) 即可（技能的前冲走 skill.json 的 lunge）。
    }

    /**
     * 释放技能（技能数据来自 skill.json）
     *
     * @param def 技能定义，其中 animation 就是绑定的 spine 动画名
     * @param onHit 每段命中的回调，index 从 0 递增；多段技能会被调用多次
     */
    public playSkill (
        def: SkillDef,
        onHit: (index: number) => void,
        onEnd: () => void,
    ): void {
        if (this.state === FighterState.Dead) return;

        // 没有绑定动画时退化为普攻动作，避免角色卡在原地
        if (!def.animation) {
            const fallback = this.cfg.attackPool[0];
            if (fallback) {
                this.playAttack(fallback, BATTLE.attackTargetTime, () => onHit(0), onEnd);
            } else {
                onEnd();
            }
            return;
        }

        this._walkTarget = null;
        this.state = FighterState.Skill;
        const duration = def.duration > 0 ? def.duration : BATTLE.skillTargetTime;
        this._runTimed(def.animation, duration, def.hits.map((h) => h.at), onHit, onEnd);
        // 技能不做前冲位移：侧视角下"冲出去再退回来"会被读成「人物左右晃动」。
        // 实测 lunge=100 时峰值 50px（屏宽 750 的 6.7%），全表 36/39 个技能都配了值，
        // 自动放技能时几乎每秒荡一次；且 _startPush 会把 _pushOff 直接归零，
        // 中途重新起手还会从峰值一帧跳回原位。需要恢复时补一行：
        //   if (def.lunge > 0) this._startPush(def.lunge, 0.4);
        // 配置（skill.json 的 lunge）保留未删，随时可开。
    }

    /** 受击（技能释放中可开启霸体：只闪白吃伤害，不打断动作） */
    public playHurt (): void {
        if (this.state === FighterState.Dead) return;
        this.flash();

        // 技能霸体：技能演出期间不吃硬直、不切动作，否则长技能会被普攻反复打断，
        // 表现为「技能永远放不完整」，多段技能的后续命中也会一起丢掉
        if (BATTLE.skillSuperArmor && this.state === FighterState.Skill) return;

        this.state = FighterState.Hurt;
        this._walkTarget = null;
        // 受击不做横向击退：侧视角下位移会被读成「人物左右晃动」，
        // 反馈交给闪白 + 硬直动作。需要恢复时补一行 this._startPush(-18, 0.26)。

        const lock = BATTLE.hurtLockTime;
        if (this.cfg.hurt) {
            this._runTimed(this.cfg.hurt, lock, [], null, () => this.playIdle());
        } else {
            // 无受击动作的角色：保持当前姿态，仅给硬直
            this._timer = 0;
            this._hitAts.length = 0;
            this._hitIndex = 0;
            this._onHit = null;
            this._endAt = lock;
            this._onEnd = () => this.playIdle();
        }
    }

    /** 死亡演出：向后仰倒 + 淡出 */
    public die (): void {
        this.state = FighterState.Dead;
        this._walkTarget = null;
        this._endAt = -1;
        this._hitAts.length = 0;
        this._hitIndex = 0;
        this._onHit = null;
        this._onEnd = null;
        this.clearBuffs();

        if (this.cfg.hurt) this._queue(this.cfg.hurt, false, 0);
        else this._queue(this.cfg.idle, true, 0);

        // 血条不再有意义，淡出
        if (this._barNode && this._barNode.isValid) {
            const barOp = this._barNode.getComponent(UIOpacity) ?? this._barNode.addComponent(UIOpacity);
            tween(barOp).to(0.3, { opacity: 0 }).start();
        }

        Tween.stopAllByTarget(this.node);
        tween(this.node)
            .to(0.6, { angle: this.facing * 70 }, { easing: 'quadIn' })
            .start();
        tween(this._opacity)
            .delay(0.15)
            .to(0.5, { opacity: 60 })
            .start();
    }

    /** 受击闪白 */
    public flash (): void {
        this.spine.color = new Color(255, 130, 130, 255);
        this._flashLeft = 0.12;
    }

    /** 重置为满血并复位血条（循环模式换场用） */
    public resetHp (ratio = 1): void {
        this.hp = Math.max(1, Math.round(this.cfg.maxHp * Math.max(0.01, Math.min(1, ratio))));
        this._hpTarget = this.hp / this.cfg.maxHp;
        this._hpRatio = this._hpTarget;
        this._barDirty = true;
        this.clearBuffs();
        if (this.state === FighterState.Dead) {
            this.state = FighterState.Idle;
            this.node.angle = 0;
            this._opacity.opacity = 255;
            if (this._barNode && this._barNode.isValid) {
                const barOp = this._barNode.getComponent(UIOpacity);
                if (barOp) barOp.opacity = 255;
            }
            this.playIdle();
        }
    }

    /** 同步血条（受击 / 治疗 / 初始化后调用） */
    public syncBar (): void {
        this._hpTarget = Math.max(0, Math.min(1, this.hp / this.cfg.maxHp));
        this._barDirty = true;
    }

    // ---------------------------------------------------------------- buff

    /**
     * 施加一个 buff
     *
     * 行为完全由 buff 的字段决定（见 BuffTypes 顶部的判定顺序）：
     * 位移立即触发、控制与属性按 duration 持续、duration<=0 立即结算、
     * duration>0 且 tick>0 走周期结算。
     *
     * @param sourceAtk 施加者的攻击力快照（atkMul 口径按它算，不随后续属性变化漂移）
     * @param stacks 本次叠加层数
     * @param overrideValue 覆盖 buff 表里的 value（同一 buff 给不同技能用不同倍率）
     */
    public applyBuff (def: BuffDef, sourceAtk: number, stacks = 1, overrideValue = NaN): void {
        if (this.state === FighterState.Dead) return;

        const per = this.buffValue(def, sourceAtk, Number.isFinite(overrideValue) ? overrideValue : def.value);
        const n = Math.max(1, Math.floor(stacks));

        // 位移（击退 / 击飞）是即时表现，不占 buff 槽
        if (def.distance !== 0 || def.height > 0) this._startDisplace(def);

        // ---- 瞬时：立即结算一次 ----
        if (def.duration <= 0) {
            if (per !== 0) this._emit(def, per * n, sourceAtk, n, 0);
            return;
        }

        // ---- 持续：同名合并 ----
        const old = this._buffs.find((b) => b.def.id === def.id);
        if (old) {
            // ignore：只刷新时长、不重放（多段技能的连续击退/眩晕靠它防抽动）
            if (def.stackMode === 'ignore') {
                old.remain = Math.max(old.remain, def.duration);
                return;
            }
            old.remain = def.duration;
            if (def.stackMode === 'stack') {
                old.stacks = Math.min(def.stackMax, old.stacks + n);
            }
            old.value = per * old.stacks;
            old.tickLeft = def.tick > 0 ? def.tick : 0;
            return;
        }

        const inst: BuffInstance = {
            def,
            value: 0,
            sourceAtk,
            remain: def.duration,
            duration: def.duration,
            stacks: Math.min(def.stackMax, n),
            tickLeft: def.tick > 0 ? def.tick : 0,
        };
        inst.value = per * inst.stacks;
        this._buffs.push(inst);
    }

    /** 清空所有 buff（死亡、换场重置时调用） */
    public clearBuffs (): void {
        this._buffs.length = 0;
        this._airH = 0;
        this._airT = 0;
        this._airDur = 0;
        this._airY = 0;
    }

    /**
     * 把 buff 的 value 换算成实际数值（正 = 治疗/增益，负 = 伤害）
     *
     * 方向优先看 def.sign（-1 伤害 / 1 治疗），没填才退回 value 的正负号。
     * 这样 buff.json 里 damage 写 value: 1 也不会变成回血。
     */
    private buffValue (def: BuffDef, sourceAtk: number, value: number): number {
        let v: number;
        switch (def.valueType) {
            case 'atkMul':
                v = value * sourceAtk;
                break;
            case 'maxHpRatio':
                // 按承受者最大生命算，治疗与百分比伤害都适用
                v = value * this.cfg.maxHp;
                break;
            default:
                v = value;
                break;
        }
        if (def.sign < 0) return -Math.abs(v);
        if (def.sign > 0) return Math.abs(v);
        return v;
    }

    /** 立即结算一次（瞬时伤害 / 瞬时治疗） */
    private _emit (def: BuffDef, value: number, sourceAtk: number, stacks: number, remain: number): void {
        const cb = this.onBuffResolve;
        if (!cb) return;
        cb(this, {
            def,
            value,
            sourceAtk,
            remain,
            duration: def.duration,
            stacks,
            tickLeft: 0,
        });
    }

    /** 推进 buff：周期结算 + 到期结算（dt 是战斗时间） */
    private _tickBuffs (dt: number): void {
        if (this._buffs.length === 0) return;

        for (let i = this._buffs.length - 1; i >= 0; i--) {
            const b = this._buffs[i];
            b.remain -= dt;

            // dot / hot：每 tick 秒结算一次
            if (b.def.tick > 0) {
                b.tickLeft -= dt;
                // 容差 1e-6：帧步长是浮点数，累加 120 帧后 tickLeft 会剩 +2e-16 而不是 0，
                // 严格用 <= 0 判断会晚一帧才跳，多跳几次后最后一跳就被挤到 duration 之外了
                while (b.tickLeft <= 1e-6 && b.remain > -1e-4) {
                    b.tickLeft += b.def.tick;
                    if (b.value !== 0) this.onBuffResolve?.(this, b);
                    // 结算可能把单位打死，die() 会清空 buff 列表，必须立刻退出
                    if (this.state === FighterState.Dead || this._buffs.length === 0) return;
                }
            }

            if (b.remain <= 0) {
                // 到期结算一次，只对「没有 tick」的延迟效果生效
                if (b.def.tick <= 0 && b.value !== 0) this.onBuffResolve?.(this, b);
                if (this.state === FighterState.Dead || this._buffs.length === 0) return;
                this._buffs.splice(i, 1);
            }
        }
    }

    /** 击退 / 击飞：横向上沿「背对施法者」的方向，纵向走抛物线 */
    private _startDisplace (def: BuffDef): void {
        // 受击者一般面朝施法者，所以取反方向推开；_startPush 内部会乘 facing
        if (def.distance !== 0) this._startPush(-def.distance, def.moveTime);
        if (def.height > 0) {
            this._airH = def.height * this._gscale;
            this._airDur = def.moveTime;
            this._airT = 0;
        }
    }

    private _tickAir (dt: number): void {
        if (this._airDur <= 0) return;
        this._airT += dt;
        const p = Math.min(1, this._airT / this._airDur);
        this._airY = this._airH * Math.sin(Math.PI * p);
        if (p >= 1) {
            this._airDur = 0;
            this._airY = 0;
        }
    }

    // ---------------------------------------------------------------- 帧驱动

    public tick (dt: number): void {
        this._applyPending();

        if (this._flashLeft > 0) {
            this._flashLeft -= dt;
            if (this._flashLeft <= 0) this.spine.color = new Color(255, 255, 255, 255);
        }

        this._tickWalk(dt);
        this._tickPush(dt);
        this._tickAir(dt);
        this._syncPos();
        this._tickHeadBar(dt);
        this._tickBuffs(dt);

        if (this._endAt < 0) return;

        this._timer += dt;

        // 逐段触发命中（多段技能会连续命中多次）
        while (this._hitIndex < this._hitAts.length && this._timer >= this._hitAts[this._hitIndex]) {
            const idx = this._hitIndex++;
            const cb = this._onHit;
            if (cb) cb(idx);
        }

        if (this._timer >= this._endAt) {
            this._endAt = -1;
            this._timer = 0;
            const cb = this._onEnd;
            this._onEnd = null;
            if (cb) cb();
        }
    }

    public destroy (): void {
        Tween.stopAllByTarget(this.node);
        Tween.stopAllByTarget(this._opacity);
        if (this.node.isValid) this.node.destroy();
    }

    // ---------------------------------------------------------------- 内部

    private _syncPos (): void {
        if (!this.node || !this.node.isValid) return;
        // _pushOff 负责横向（前冲 / 击退），_airY 负责纵向（击飞）
        this.node.setPosition(this.x + this._pushOff * this.facing, this.baseY + this._airY, 0);
    }

    private _tickWalk (dt: number): void {
        if (this._walkTarget === null) return;

        // 走位过程中被打断（攻击 / 受击）时直接取消
        if (this.state !== FighterState.Move && this.state !== FighterState.Idle) {
            this._walkTarget = null;
            return;
        }

        const delta = this._walkTarget - this.x;
        const step = this._walkSpeed * dt;
        if (Math.abs(delta) <= step) {
            this.x = this._walkTarget;
            this._walkTarget = null;
            if (this.state === FighterState.Move) this.playIdle();
            return;
        }

        this.x += Math.sign(delta) * step;
        this.setFacing(delta > 0 ? 1 : -1);
    }

    /** 前冲 / 击退：sin 曲线，两端为 0，中间达到峰值 */
    private _startPush (dist: number, dur: number): void {
        this._pushDist = dist * this._gscale;
        this._pushT = 0;
        this._pushDur = dur;
        this._pushOff = 0;
    }

    private _tickPush (dt: number): void {
        if (this._pushDur <= 0) return;
        this._pushT += dt;
        const p = Math.min(1, this._pushT / this._pushDur);
        this._pushOff = this._pushDist * Math.sin(Math.PI * p);
        if (p >= 1) {
            this._pushDur = 0;
            this._pushOff = 0;
        }
    }

    /**
     * @param targetDuration 目标演出时长；<=0 时按动画原速（用原时长计时）
     * @param hitPoints 命中时机（0~1 相对进度）
     */
    private _runTimed (
        name: string,
        targetDuration: number,
        hitPoints: number[],
        onHit: ((index: number) => void) | null,
        onEnd: (() => void) | null,
    ): void {
        const duration = targetDuration > 0 ? targetDuration : this._rawDuration(name);
        this._queue(name, false, duration);
        this._timer = 0;
        this._endAt = duration;
        this._hitAts = hitPoints.map((p) => duration * Math.max(0.02, Math.min(0.98, p)));
        this._hitIndex = 0;
        this._onHit = onHit;
        this._onEnd = onEnd;
    }

    /** @param targetDuration 目标演出时长；0 表示按动画原速 */
    private _queue (name: string, loop: boolean, targetDuration: number): void {
        this._pendingName = name;
        this._pendingLoop = loop;
        this._pendingTarget = targetDuration;
        this._pendingToken++;
    }

    /** 读取动画原始时长（骨架未就绪或动画不存在时返回兜底值） */
    private _rawDuration (name: string): number {
        try {
            const anim = this.spine.findAnimation(name);
            if (anim && anim.duration > 0) return anim.duration;
        } catch (e) { /* 忽略：骨架尚未实例化 */ }
        return 1;
    }

    /**
     * 用骨架内动画的真实时长换算出播放倍速，
     * 让动画正好在目标时长内播完（普攻压缩、技能提速都靠它）。
     */
    private _computeTimeScale (): number {
        if (this._pendingTarget <= 0) return 1;
        const raw = this._rawDuration(this._pendingName);
        if (raw <= 0.01) return 1;
        return Math.max(0.15, Math.min(6, raw / this._pendingTarget));
    }

    /**
     * WASM 骨架实例可能在组件创建后的一两帧才就绪，
     * 因此动画请求先入队，在 tick 中确认就绪后再真正下发。
     */
    private _applyPending (): void {
        if (this._appliedToken === this._pendingToken) return;
        const comp: any = this.spine;
        if (!comp || !comp.isValid || !comp.skeletonData) return;

        // _skeleton 为空说明骨骼运行时数据尚未实例化
        if (comp._skeleton == null) {
            this._retryCount++;
            // 每 30 帧重新触发一次骨骼数据初始化，最多坚持 300 帧
            if (this._retryCount % 30 === 0 && this._retryCount <= 300) {
                const data = comp.skeletonData;
                comp.skeletonData = null;
                comp.skeletonData = data;
            }
            return;
        }

        this._retryCount = 0;
        this._appliedToken = this._pendingToken;
        try {
            if (!this._alphaFixed) {
                this._alphaFixed = true;
                this.spine.premultipliedAlpha = false;
            }
            // 骨架里没有这个动画时 setAnimation 是静默失败的：角色会定格在上一姿势，
            // 表现成「动作播到一半卡住」，所以这里显式告警一次
            const found = comp.findAnimation ? comp.findAnimation(this._pendingName) : true;
            if (!found) {
                console.warn(
                    `[Fighter] ${this.cfg.id} 的骨架里没有动画 "${this._pendingName}"，`
                    + '请检查 anim.json / skill.json 里的 anim 名字',
                );
            }
            this.spine.timeScale = this._computeTimeScale() * this._speedScale;
            this.spine.setAnimation(0, this._pendingName, this._pendingLoop);
        } catch (e) {
            console.warn(`[Fighter] 播放动画 "${this._pendingName}" 失败：`, e);
        }
    }

    // ---------------------------------------------------------------- 头顶血条

    private _buildHeadBar (): void {
        this._barNode = new Node('hpBar');
        this._barNode.layer = Layers.Enum.UI_2D;
        this._barNode.addComponent(UITransform);
        this._barNode.setParent(this.node);
        this._barNode.addComponent(UIOpacity);

        this._barG = this._barNode.addComponent(Graphics);

        const nameNode = new Node('hpName');
        nameNode.layer = Layers.Enum.UI_2D;
        nameNode.addComponent(UITransform);
        nameNode.setParent(this._barNode);
        this._barName = nameNode.addComponent(Label);
        this._barName.string = this.cfg.name;
        this._barName.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._barName.verticalAlign = Label.VerticalAlign.CENTER;
        this._barName.overflow = Label.Overflow.NONE;
        this._barName.color = this._barAccent;
        (this._barName as any).isBold = true;

        const valNode = new Node('hpVal');
        valNode.layer = Layers.Enum.UI_2D;
        valNode.addComponent(UITransform);
        valNode.setParent(this._barNode);
        this._barValue = valNode.addComponent(Label);
        this._barValue.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._barValue.verticalAlign = Label.VerticalAlign.CENTER;
        this._barValue.overflow = Label.Overflow.NONE;
        this._barValue.color = new Color(240, 246, 255, 255);
        (this._barValue as any).isBold = true;

        this._layoutHeadBar();
        this._barDirty = true;
    }

    /** 血条尺寸与位置随缩放变化；尺度单独限制，避免角色很小的时候血条读不清 */
    private _layoutHeadBar (): void {
        if (!this._barNode || !this._barNode.isValid) return;

        const uiScale = Math.max(0.75, Math.min(1.15, this._gscale));
        this._barW = BATTLE.headBarWidth * uiScale;
        this._barH = 15 * uiScale;

        const barY = (this.cfg.headY - this.cfg.anchorY) * this._scale + BATTLE.headBarOffsetY * uiScale;
        this._barNode.setPosition(0, barY, 0);

        this._barNode.getComponent(UITransform)!.setContentSize(this._barW, this._barH);

        const nameNode = this._barName!.node;
        nameNode.getComponent(UITransform)!.setContentSize(this._barW + 60 * uiScale, 26 * uiScale);
        nameNode.setPosition(0, this._barH * 0.5 + 13 * uiScale, 0);
        this._barName.fontSize = Math.round(17 * uiScale);
        this._barName.lineHeight = Math.round(21 * uiScale);

        const valNode = this._barValue!.node;
        valNode.getComponent(UITransform)!.setContentSize(this._barW, this._barH);
        valNode.setPosition(0, 0, 0);
        this._barValue.fontSize = Math.round(13 * uiScale);
        this._barValue.lineHeight = Math.round(15 * uiScale);
    }

    private _tickHeadBar (dt: number): void {
        if (!this._barNode || !this._barNode.isValid) return;

        const diff = this._hpTarget - this._hpRatio;
        if (Math.abs(diff) > 0.0015) {
            this._hpRatio += diff * Math.min(1, dt * 12);
            this._barDirty = true;
        } else if (this._barDirty) {
            this._hpRatio = this._hpTarget;
        }

        if (!this._barDirty) return;
        this._barDirty = false;
        this._drawHeadBar();
    }

    private _drawHeadBar (): void {
        const g = this._barG;
        const w = this._barW;
        const h = this._barH;
        const r = h / 2;
        const ratio = Math.max(0, Math.min(1, this._hpRatio));

        g.clear();

        // 外框底
        g.fillColor = new Color(10, 16, 28, 200);
        g.roundRect(-w / 2, -h / 2, w, h, r);
        g.fill();

        // 血量
        const inset = Math.max(2, h * 0.16);
        const filled = ratio * (w - inset * 2);
        if (filled > 1) {
            const low = ratio <= 0.25;
            const c = low ? new Color(255, 96, 96, 255) : this._barAccent;
            g.fillColor = c;
            g.roundRect(-w / 2 + inset, -h / 2 + inset, filled, h - inset * 2, (h - inset * 2) / 2);
            g.fill();
        }

        g.lineWidth = Math.max(1, h * 0.1);
        g.strokeColor = new Color(120, 150, 190, 150);
        g.roundRect(-w / 2, -h / 2, w, h, r);
        g.stroke();

        this._barValue.string = `${Math.max(0, Math.ceil(this.hp))}`;
    }
}
