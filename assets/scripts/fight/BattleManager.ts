import { _decorator, Color, Component, Graphics, Layers, Node, UITransform, Vec3 } from 'cc';
import { BATTLE, BUFFS, CHARACTERS, CharacterConfig, findCharacter } from './BattleConfig';
import { BattleUI } from './BattleUI';
import type { BuffInstance } from './BuffTypes';
import { Fighter, FighterState } from './Fighter';
import { GameConfig } from './GameConfig';
import { SpineLoader } from './SpineLoader';
import type { SkillDef } from './SkillTypes';
import { clamp, getViewport, offResize, onResize, Viewport } from './Viewport';

const { ccclass } = _decorator;

/** 脚底线在可视高度中的比例（720×1280 时 = 470，即 y = -170，再叠加 BATTLE.groundOffsetY） */
const GROUND_RATIO = 0.5;

/** 「随机」敌人占位标识（设置面板里选择） */
export const RANDOM_ENEMY = 'random';

function hex(s: string): Color {
    const c = new Color();
    c.fromHEX(s);
    return c;
}

/**
 * 模拟战斗主控
 *
 * 战斗在一条**横向长世界**里进行（宽度 = 屏宽 × worldWidthScreens），
 * 镜头带着死区跟随主角平移。双方不再站桩：
 *   1. 主角按方向行走，敌人进入 aggro 距离后开始靠近；
 *   2. 双方各自以**自己的射程**为准，谁先进入自己的射程谁就先出手；
 *   3. 循环模式下主角击杀后不弹窗，随机换向、随机换敌继续打。
 */
@ccclass('BattleManager')
export class BattleManager extends Component {
    private _stage: Node = null!;
    private _groundNode: Node = null!;
    private _groundG: Graphics = null!;
    private _floatLayer: Node = null!;
    private _ui: BattleUI = null!;

    // ---- 适配参数（由 _applyStageMetrics 按可视区计算） ----
    private _vp: Viewport = getViewport();
    /** 角色脚底所在的父节点 Y */
    private _groundY = -170;
    /** 角色整体缩放系数（屏幕适配 × characterScale） */
    private _gscale = 1;
    /** 战斗世界半宽（横向活动范围） */
    private _worldHalf = 720;

    // ---- 镜头 ----
    private _camX = 0;
    private _camTargetX = 0;
    private _shake = 0;

    // ---- 参战单位 ----
    private _left: Fighter | null = null;
    private _right: Fighter | null = null;

    /** 配置加载完成后才会赋值（见 start） */
    private _leftId: string = '';
    /** 可能是具体角色 id，也可能是 RANDOM_ENEMY */
    private _rightId: string = '';
    private _speedIndex = 1;
    private _loopMode = false;
    /** 循环模式下已连续击杀数 */
    private _killStreak = 0;

    private _running = false;
    private _over = false;
    private _loading = false;
    private _paused = false;

    // ---- 走位状态 ----
    /** 敌人是否已被激活（进入 aggro 距离） */
    private _enemyActive = false;
    /** 本场的敌人激活距离（= 刷新距离 × aggroRatio） */
    private _aggroDist = 600;
    /** 主角当前的漫游方向 */
    private _roamDir: 1 | -1 = 1;

    /** 左方（玩家）各技能的剩余冷却，下标与 cfg.skills 一致 */
    private _leftCd: number[] = [];
    /** 右方（AI）各技能的剩余冷却 */
    private _rightCd: number[] = [];
    /** AI 决策节流计时（右方 / 敌方） */
    private _aiThink = 0;
    /** AI 决策节流计时（左方「自动技能」用，反应比敌方快一点） */
    private _aiThinkL = 0;
    /** 左方是否自动释放技能（顶部「自动」按钮控制） */
    private _autoSkill = false;

    /**
     * 玩家点击技能时的排队请求（-1 表示没有）
     *
     * ★ 为什么需要：普攻动作 0.8s，而普攻冷却只有 0.2s 且在动作开始时就开始走，
     *   所以动作一结束冷却早就好了 → 待机状态只存在一帧，玩家几乎不可能点中。
     *   这里把点击记下来，等回到待机的那一帧自动释放，避免「点了没反应」。
     */
    private _pendingSkill = -1;
    /** 排队请求的剩余有效期（秒），超时作废 */
    private _pendingSkillTime = 0;

    // ---------------------------------------------------------------- 生命周期

    protected onLoad(): void {
        // 场景要等配置就绪后再搭：UI 的角色下拉、角色缩放都来自配置表
        // 窗口缩放 / 横竖屏切换 / 浏览器地址栏收起时重排界面
        onResize(this._onViewportChange, this);
    }

    protected async start(): Promise<void> {
        const ok = await GameConfig.load();
        if (!this.isValid) return;

        this._buildScene();

        if (!ok || CHARACTERS.length === 0) {
            this._ui.setLoading('角色配置加载失败');
            this._ui.log(`[ 配置 ] ${GameConfig.error}`);
            this._ui.log('  请检查 assets/resources/config/ 下的 battle / character / spine / anim / buff / skill');
            return;
        }
        for (const w of GameConfig.warnings) this._ui.log(`[ 配置 ] ${w}`);

        // 开局阵容来自 battle.json 的 defaultHeroId / defaultEnemyId；
        // id 写错时回退角色表顺序，不会因为一处配置笔误就开不了局
        this._leftId = this._pickStartId(BATTLE.defaultHeroId, 0, CHARACTERS[0].id);
        this._rightId = this._pickStartId(BATTLE.defaultEnemyId, 1, RANDOM_ENEMY);
        void this._startBattle(this._leftId, this._rightId);
    }

    protected update(dt: number): void {
        // start() 是 async：配置表还在加载时 _stage 尚未创建，
        // 而 update 从第一帧就开始跑，这里必须先等场景就绪
        if (!this._stage || !this._stage.isValid) return;

        this._updateCamera(dt);
        this._updateShake(dt);
        if (!this._running || this._paused) return;

        const L = this._left;
        const R = this._right;
        if (!L || !R) return;

        // 战斗时间：速度只影响战斗逻辑与动画，不影响镜头与震屏
        const spd = this._getSpeed();
        // spine 动画按真实时间推进，必须把倍速同步进去，否则 x2/x3 时动作只播一半
        L.setSpeedScale(spd);
        R.setSpeedScale(spd);
        const sdt = dt * spd;
        L.tick(sdt);
        R.tick(sdt);

        this._tickCooldowns(this._leftCd, sdt);
        this._tickCooldowns(this._rightCd, sdt);

        if (this._over) {
            this._refreshSkillBar(L, false);
            return;
        }

        this._tickApproach(L, R, sdt);
        // 双方的技能都要抢在普攻之前出手：
        // 待机状态只存在一帧，晚一步就被普攻抢占动作，技能永远放不出来
        this._tickPendingSkill(sdt);
        // 左方开启「自动」后与敌方共用同一套决策，同样要抢在普攻之前
        if (this._autoSkill) this._tickAiSkill(L, R, sdt, this._leftCd, true);
        this._tickAiSkill(R, L, sdt, this._rightCd);
        this._tickAutoAttack(L, R, sdt);
        this._tickAutoAttack(R, L, sdt);

        this._refreshSkillBar(L, true);
    }

    protected onDestroy(): void {
        offResize(this._onViewportChange, this);
        this._clearFighters();
    }

    // ---------------------------------------------------------------- 适配

    /**
     * 依据当前可视区算出脚底线、世界宽度与角色缩放。
     *
     * 实际缩放 = 屏幕适配系数 × BATTLE.characterScale
     * 世界宽度 = 可视宽度 × BATTLE.worldWidthScreens（决定镜头能横向滚多远）
     */
    private _applyStageMetrics(): void {
        const vp = this._vp = getViewport();
        const usableH = vp.height - vp.safe.top - vp.safe.bottom;

        // 脚底线 + 手动的整体上移量
        this._groundY = -vp.halfH + vp.safe.bottom + usableH * GROUND_RATIO + BATTLE.groundOffsetY;

        // 角色缩放 = 屏幕适配系数 × 场景倍率
        this._gscale = clamp(vp.halfW / 360, 0.62, 1) * BATTLE.characterScale;

        // 世界至少一屏宽，否则镜头无从滚动
        this._worldHalf = Math.max(vp.halfW, vp.halfW * BATTLE.worldWidthScreens);

        console.log(
            `[战斗] 角色缩放 x${this._gscale.toFixed(2)}`
            + ` | 地面 y=${this._groundY.toFixed(0)} | 世界半宽 ${this._worldHalf.toFixed(0)}`,
        );
    }

    /** 可视区变化：重排 UI 与已有角色，不重启战斗 */
    private _onViewportChange(): void {
        // 配置还没加载完时场景尚未搭建，此时只需等 start 里统一排版
        if (!this.isValid || !this._stage) return;

        this._applyStageMetrics();
        const vp = this._vp;

        const ut = this.node.getComponent(UITransform);
        if (ut) ut.setContentSize(vp.width, vp.height);

        for (const n of [this._stage, this._floatLayer]) {
            const t = n.getComponent(UITransform);
            if (t) t.setContentSize(vp.width, vp.height);
        }

        this._redrawGround();
        this._ui?.relayout();
        // 地面高度也会随安全区/上移量变化
        if (this._groundNode) this._groundNode.setPosition(0, this._groundY, 0);

        if (this._left) {
            this._left.setX(clamp(this._left.x, -this._worldHalf + 120, this._worldHalf - 120));
            this._left.applyLayout(this._groundY, this._gscale);
        }
        if (this._right) {
            this._right.setX(clamp(this._right.x, -this._worldHalf + 120, this._worldHalf - 120));
            this._right.applyLayout(this._groundY, this._gscale);
        }

        // 镜头立即对齐，避免窗口变化后出现跳变
        this._camX = this._clampCam(this._left ? this._left.x : 0);
        this._camTargetX = this._camX;
        this._applyCameraTransform();
    }

    // ---------------------------------------------------------------- 镜头

    /** 把镜头中心限制在世界范围内（世界不比屏幕宽时固定居中） */
    private _clampCam(x: number): number {
        const maxCam = Math.max(0, this._worldHalf - this._vp.halfW);
        return clamp(x, -maxCam, maxCam);
    }

    /** 死区跟随：主角在死区内移动时镜头不动，超出后平滑跟进 */
    private _updateCamera(dt: number): void {
        const focus = this._left && this._left.alive ? this._left.x : this._camX;
        const dz = BATTLE.camDeadZone * this._gscale;
        const off = focus - this._camTargetX;

        if (off > dz) this._camTargetX = focus - dz;
        else if (off < -dz) this._camTargetX = focus + dz;

        this._camTargetX = this._clampCam(this._camTargetX);
        const k = Math.min(1, dt * 7);
        this._camX += (this._camTargetX - this._camX) * k;
        this._camX = this._clampCam(this._camX);

        this._applyCameraTransform();
    }

    private _applyCameraTransform(): void {
        // 兜底：场景未建好时（配置加载中 / 已销毁）直接跳过
        if (!this._stage || !this._stage.isValid) return;

        let sx = 0;
        let sy = 0;
        if (this._shake > 0.3) {
            sx = (Math.random() - 0.5) * this._shake;
            sy = (Math.random() - 0.5) * this._shake;
        }
        this._stage.setPosition(-this._camX + sx, sy, 0);
    }

    private _updateShake(dt: number): void {
        if (this._shake > 0.3) {
            this._shake = Math.max(0, this._shake - dt * 55);
        } else if (this._shake !== 0) {
            this._shake = 0;
        }
        // 震屏值变化后立即合成到镜头位移上（否则会延后一帧）
        this._applyCameraTransform();
    }

    // ---------------------------------------------------------------- 场景搭建

    private _buildScene(): void {
        this._applyStageMetrics();
        const vp = this._vp;

        this.node.addComponent(UITransform).setContentSize(vp.width, vp.height);
        this.node.setPosition(0, 0, 0);

        // 角色层（整体承载镜头平移与震屏）
        this._stage = new Node('stage');
        this._stage.layer = Layers.Enum.UI_2D;
        this._stage.addComponent(UITransform).setContentSize(vp.width, vp.height);
        this._stage.setParent(this.node);

        // 地面（横贯整个战斗世界）
        this._groundNode = new Node('ground');
        this._groundNode.layer = Layers.Enum.UI_2D;
        this._groundNode.addComponent(UITransform);
        this._groundNode.setParent(this._stage);
        this._groundNode.setPosition(0, this._groundY, 0);
        this._groundG = this._groundNode.addComponent(Graphics);
        this._redrawGround();

        // 飘字层（位于角色之上、UI 之下）
        this._floatLayer = new Node('floats');
        this._floatLayer.layer = Layers.Enum.UI_2D;
        this._floatLayer.addComponent(UITransform).setContentSize(vp.width, vp.height);
        this._floatLayer.setParent(this._stage);

        this._ui = new BattleUI(this.node, this._floatLayer, {
            onSkill: (index) => this._castSkill(index),
            onSpeedTap: () => this._cycleSpeed(),
            onToggleLoop: (on) => this._toggleLoop(on),
            onToggleAutoSkill: (on) => {
                this._autoSkill = on;
                this._aiThinkL = 0;
                this._ui.log(on ? '[ 提示 ]  自动释放技能：已开启' : '[ 提示 ]  自动释放技能：已关闭');
            },
            onOpenSettings: () => {
                this._paused = true;
                this._ui.openSettings(this._leftId, this._rightId, this._getSpeed(), this._loopMode);
            },
            onCloseSettings: () => {
                this._paused = false;
                this._ui.closeSettings();
            },
            onRestart: () => {
                this._ui.hideResult();
                this._killStreak = 0;
                void this._startBattle(this._leftId, this._rightId);
            },
            onApply: (leftId, rightId, speed, loopMode) => {
                this._leftId = leftId;
                this._rightId = rightId;
                this._speedIndex = Math.max(0, BATTLE.speedOptions.indexOf(speed));
                this._loopMode = loopMode;
                this._killStreak = 0;
                this._ui.setSpeedLabel(this._getSpeed());
                this._ui.setLoopToggle(loopMode);
                this._paused = false;
                this._ui.hideResult();
                void this._startBattle(leftId, rightId);
            },
        });

        this._ui.setSpeedLabel(this._getSpeed());
        this._ui.setLoopToggle(this._loopMode);
        this._ui.setAutoSkillToggle(this._autoSkill);
    }

    /** 地面与刻度：横向铺满整个世界，靠刻度能看出镜头在滚动 */
    private _redrawGround(): void {
        const g = this._groundG;
        if (!g || !g.isValid) return;

        const half = this._worldHalf + 240;
        g.clear();

        // 地面主色带
        g.fillColor = new Color(28, 40, 62, 255);
        g.rect(-half, -160, half * 2, 160);
        g.fill();

        // 地面亮线
        g.lineWidth = 3;
        g.strokeColor = new Color(92, 130, 176, 170);
        g.moveTo(-half, 0);
        g.lineTo(half, 0);
        g.stroke();

        // 刻度（每 240 一根，长短交替）
        const step = 240;
        for (let x = -Math.floor(half / step) * step; x <= half; x += step) {
            const major = Math.abs(x % (step * 2)) < 1;
            g.lineWidth = major ? 3 : 2;
            g.strokeColor = major ? new Color(92, 130, 176, 110) : new Color(92, 130, 176, 55);
            g.moveTo(x, 0);
            g.lineTo(x, major ? 46 : 24);
            g.stroke();
        }

        // 左右边界柱
        for (const bx of [-this._worldHalf, this._worldHalf]) {
            g.fillColor = new Color(70, 100, 140, 90);
            g.rect(bx - 6, 0, 12, 300);
            g.fill();
        }
    }

    // ---------------------------------------------------------------- 战斗流程

    /**
     * 解析 battle.json 里的开局阵容 id
     *
     * - 填 'random' 原样返回（敌方交给 _resolveEnemyId 每场随机）
     * - 角色表里存在则直接使用
     * - 否则回退到角色表第 idx 项，仍取不到时用 fallback
     */
    private _pickStartId(id: string, idx: number, fallback: string): string {
        if (!id) return fallback;
        if (id === RANDOM_ENEMY) return id;
        if (CHARACTERS.some((c) => c.id === id)) return id;
        const alt = CHARACTERS[idx];
        this._ui.log(`[ 配置 ] battle.json 的默认角色 "${id}" 不存在，已回退为 ${alt ? alt.id : fallback}`);
        return alt ? alt.id : fallback;
    }

    /** 把「随机」占位换成具体角色 id */
    private _resolveEnemyId(leftId: string, rightId: string): string {
        if (rightId && rightId !== RANDOM_ENEMY) return rightId;
        const pool = CHARACTERS.filter((c) => c.id !== leftId);
        if (pool.length === 0) return CHARACTERS[0].id;
        return pool[Math.floor(Math.random() * pool.length)].id;
    }

    private async _startBattle(leftId: string, rightId: string): Promise<void> {
        if (this._loading) return;
        this.unscheduleAllCallbacks();
        this._loading = true;
        this._paused = false;
        this._running = false;
        this._over = false;
        this._shake = 0;
        this._enemyActive = false;
        this._roamDir = 1;
        this._pendingSkill = -1;
        this._pendingSkillTime = 0;
        this._aiThink = 0;
        this._aiThinkL = 0;

        this._clearFighters();
        this._ui.hideResult();
        this._ui.setLoading('加载角色资源…');

        const enemyId = this._resolveEnemyId(leftId, rightId);
        const leftCfg = findCharacter(leftId);
        const rightCfg = findCharacter(enemyId);

        // 角色池与显示参数来自配置表，未就绪时无法开打
        if (!GameConfig.ready) {
            this._ui.setLoading('角色配置未加载');
            this._ui.log(`[ 配置 ] ${GameConfig.error}`);
            this._loading = false;
            return;
        }

        try {
            const [lData, rData] = await Promise.all([
                SpineLoader.load(leftCfg.bundlePath),
                SpineLoader.load(rightCfg.bundlePath),
            ]);

            if (!this.isValid) return;

            // 用骨架里真实的动画名校验绑定表，写错了会提前在控制台告警
            GameConfig.validateAgainstSkeleton(leftCfg.id, lData);
            GameConfig.validateAgainstSkeleton(rightCfg.id, rData);

            // 角色池 13 个、其中 6 个是 4096 图集，只保留当前在场的两个，其余释放
            SpineLoader.releaseExcept([leftCfg.bundlePath, rightCfg.bundlePath]);

            this._applyStageMetrics();
            this._redrawGround();

            // ---- 站位：主角从一端出发，敌人在行进方向的前方待命 ----
            const heroX = -this._worldHalf * 0.55;
            // 刷新距离至少是主角射程的 1.35 倍，否则一开局就在射程内、走位就没意义了
            const spawnDist = Math.max(
                260,
                leftCfg.attackRange * this._gscale * 1.35,
                this._loopMode
                    ? BATTLE.spawnDistance * this._gscale
                    : BATTLE.approachTime * leftCfg.moveSpeed * this._gscale,
            );
            this._aggroDist = spawnDist * BATTLE.aggroRatio;

            let dir: 1 | -1 = this._roamDir;
            let enemyX = this._clampWorldX(heroX + dir * spawnDist);
            // 该方向被世界边界压缩得太多时改朝另一侧刷新
            if (Math.abs(enemyX - heroX) < spawnDist * 0.85) {
                dir = (dir > 0 ? -1 : 1) as 1 | -1;
                enemyX = this._clampWorldX(heroX + dir * spawnDist);
                this._roamDir = dir;
            }

            this._left = this._bindBuffs(
                new Fighter(this._stage, leftCfg, lData, dir, this._groundY, this._gscale),
            );
            this._left.placeAt(heroX);
            this._left.syncBar();

            this._right = this._bindBuffs(
                new Fighter(this._stage, rightCfg, rData, dir > 0 ? -1 : 1, this._groundY, this._gscale),
            );
            this._right.placeAt(enemyX);
            this._right.setFacing(enemyX >= heroX ? -1 : 1);
            this._right.syncBar();

            // 角色要排在飘字层之下
            const floatIdx = this._floatLayer.getSiblingIndex();
            this._left.node.setSiblingIndex(floatIdx);
            this._right.node.setSiblingIndex(floatIdx);

            // 镜头对齐主角
            this._camX = this._clampCam(heroX);
            this._camTargetX = this._camX;
            this._applyCameraTransform();

            // 首个动作错开，避免完全同步
            this._left.cooldown = this._rand(BATTLE.firstDelayMin, BATTLE.firstDelayMax);
            this._right.cooldown = this._rand(BATTLE.firstDelayMin, BATTLE.firstDelayMax);

            // 技能冷却（开局全部就绪）
            this._leftCd = new Array(leftCfg.skills.length).fill(0);
            this._rightCd = new Array(rightCfg.skills.length).fill(0);
            this._aiThink = 1.2;

            this._ui.refreshCharacterNames();
            this._ui.setFighters(leftId, enemyId);
            this._ui.clearLog();
            this._ui.setLoading('');
            this._ui.setStreak(this._loopMode ? 0 : -1);
            this._ui.log(`[ 战斗开始 ]  ${leftCfg.name}  VS  ${rightCfg.name}`);
            this._ui.setEnergy(0);

            if (this._loopMode) this._ui.log(`[ 循环 ]  已开启，击杀后自动续战`);

            this._running = true;
        } catch (e: any) {
            this._ui.setLoading(`资源加载失败：${e && e.message ? e.message : e}`);
            console.error('[BattleManager] 战斗初始化失败', e);
        } finally {
            this._loading = false;
        }
    }

    private _clampWorldX(x: number): number {
        const margin = 110;
        return clamp(x, -this._worldHalf + margin, this._worldHalf - margin);
    }

    /** 给 Fighter 接上 buff 结算回调（瞬时伤害 / 周期跳伤 / 治疗都回到战斗层处理） */
    private _bindBuffs(f: Fighter): Fighter {
        f.onBuffResolve = (owner, inst) => this._resolveBuff(owner, inst);
        return f;
    }

    // ---------------------------------------------------------------- 走位

    /**
     * 走位与遭遇：
     *   1. 敌人未激活 → 主角按 roamDir 漫游，敌人原地站立；
     *   2. 距离 ≤ aggro → 敌人激活，双方各自朝对方走；
     *   3. 各自走到**自己射程**内就停步开打（射程远的先出手）。
     */
    private _tickApproach(L: Fighter, R: Fighter, _dt: number): void {
        if (!L.alive || !R.alive) return;

        // 控制效果：眩晕 / 定身期间不再接受走位指令，已经走起来的立刻停步
        if (!L.canMove) L.stopWalk();
        if (!R.canMove) R.stopWalk();

        const dist = L.distanceTo(R);

        // ---- 敌人激活 ----
        if (!this._enemyActive && dist <= this._aggroDist) {
            this._enemyActive = true;
            this._ui.log(`[ 遭遇 ]  ${R.cfg.name} 发现了你，开始逼近`);
        }

        // ---- 左方（主角） ----
        if (L.canMove && (L.state === FighterState.Idle || L.state === FighterState.Move)) {
            if (!this._enemyActive) {
                // 漫游：走到世界边缘则调头；目标每帧前移，保持持续行走
                const edge = this._worldHalf - 120;
                if ((this._roamDir > 0 && L.x >= edge) || (this._roamDir < 0 && L.x <= -edge)) {
                    this._roamDir = (this._roamDir > 0 ? -1 : 1) as 1 | -1;
                }
                L.walkTo(L.x + this._roamDir * 320, L.moveSpeed);
            } else {
                // 停在自己射程的 90% 处：射程远的会更早停步、更早开打
                const stop = L.attackRange * 0.9;
                if (dist > stop) {
                    L.walkTo(R.x, L.moveSpeed, stop);
                } else {
                    L.stopWalk();
                    L.setFacing(R.x >= L.x ? 1 : -1);
                }
            }
        }

        // ---- 右方（敌人）：未激活时原地站立 ----
        if (this._enemyActive && R.canMove && (R.state === FighterState.Idle || R.state === FighterState.Move)) {
            const stop = R.attackRange * 0.9;
            if (dist > stop) {
                R.walkTo(L.x, R.moveSpeed, stop);
            } else {
                R.stopWalk();
                R.setFacing(L.x <= R.x ? -1 : 1);
            }
        }
    }

    // ---------------------------------------------------------------- 攻击

    /**
     * 自动普攻判定
     *
     * ★ 冷却从「动作结束」开始算：出手期间（Attack / Skill）冷却冻结，
     *   动作播完由 onEnd 把冷却置为 BATTLE.attackInterval。
     *   这样两次出手之间必然存在一段完整的待机窗口，玩家点击 / AI 决策
     *   都有机会插进来；否则待机只存在一帧，技能几乎永远放不出来。
     */
    private _tickAutoAttack(attacker: Fighter, target: Fighter, dt: number): void {
        if (!attacker.alive || !target.alive) return;

        // 演出中不推进普攻冷却，等动作结束再起算
        if (attacker.state !== FighterState.Attack && attacker.state !== FighterState.Skill) {
            attacker.cooldown -= dt;
        }
        if (attacker.state !== FighterState.Idle) return;
        // 眩晕期间不能出手（走位也在 _tickApproach 里被拦下）
        if (!attacker.canAct) return;
        if (attacker.cooldown > 0) return;
        if (attacker.distanceTo(target) > attacker.attackRange) return;

        const pool = attacker.cfg.attackPool;
        const anim = pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
        const duration = BATTLE.attackTargetTime;

        // 冷却不在出手瞬间赋值：被打断时不该白等一段动作时间
        attacker.playAttack(
            anim,
            duration,
            () => this._resolveHit(attacker, target),
            () => {
                attacker.cooldown = BATTLE.attackInterval;
                attacker.playIdle();
            },
        );
    }

    /** 手动释放技能（左方 / 玩家），index 为技能下标（skill1 → 0） */
    private _castSkill(index: number): void {
        const L = this._left;
        const R = this._right;
        if (!this._running || this._over || this._paused || !L || !R) return;
        if (!L.alive || !R.alive) return;

        const def = L.cfg.skills[index];
        if (!def) return;
        // 眩晕 / 沉默期间不能放技能
        if (!L.canCast) {
            this._ui.log(`[ 提示 ]  ${L.cfg.name} 被控制中，无法释放 ${def.name}`);
            return;
        }
        if (this._leftCd[index] > 0) return;
        if (L.energy < def.energyCost) {
            this._ui.log(`[ 提示 ]  能量不足，${def.name} 需要 ${def.energyCost}`);
            return;
        }
        if (L.distanceTo(R) > L.rangeOf(def)) {
            this._ui.log(`[ 提示 ]  距离过远，${def.name} 需要靠近一些`);
            return;
        }

        // 受击硬直中不改动作，排队到硬直结束再放（见 _tickPendingSkill）
        if (L.state === FighterState.Hurt) {
            this._pendingSkill = index;
            this._pendingSkillTime = 0.6;
            return;
        }

        // 普攻动作进行中允许直接打断：玩家点了就该立刻出手，
        // 代价是这一次普攻不再结算（_runTimed 会覆盖掉它的命中回调）
        this._executeSkill(L, R, index, this._leftCd);
    }

    /**
     * 消化排队的技能请求
     *
     * 每帧在普攻判定之前调用：角色刚回到待机的那一帧就把技能放出去，
     * 否则同一帧的普攻会立刻抢占动作，排队永远等不到 Idle。
     */
    private _tickPendingSkill (dt: number): void {
        if (this._pendingSkill < 0) return;

        const L = this._left;
        const R = this._right;
        if (!L || !R || !this._running || this._over || this._paused) {
            this._pendingSkill = -1;
            return;
        }

        this._pendingSkillTime -= dt;
        if (this._pendingSkillTime <= 0 || !L.alive || !R.alive) {
            this._pendingSkill = -1;
            return;
        }
        if (L.state !== FighterState.Idle) return;

        const index = this._pendingSkill;
        this._pendingSkill = -1;

        // 排队期间状态可能变了（能量被扣、目标走远），执行前再核一次
        const def = L.cfg.skills[index];
        if (!def) return;
        if (!L.canCast) return;
        if (this._leftCd[index] > 0) return;
        if (L.energy < def.energyCost) return;
        if (L.distanceTo(R) > L.rangeOf(def)) return;

        this._executeSkill(L, R, index, this._leftCd);
    }

    /** 统一的技能执行流程（玩家与 AI 共用） */
    private _executeSkill(
        caster: Fighter,
        target: Fighter,
        index: number,
        cds: number[],
    ): void {
        const def = caster.cfg.skills[index];
        if (!def) return;

        caster.setFacing(target.x >= caster.x ? 1 : -1);
        caster.energy = Math.max(0, caster.energy - def.energyCost);
        cds[index] = def.cooldown;
        if (caster === this._left) this._ui.setEnergy(caster.energy);

        // 真正播哪个动画由 def.animation 决定，见 skill.json
        caster.playSkill(
            def,
            (hitIndex) => this._resolveSkillHit(caster, target, def, hitIndex),
            () => caster.playIdle(),
        );

        // 打出打击点的秒数，方便对着动画核 at 的值
        const times = def.duration > 0
            ? def.hits.map((h) => `${(h.at * def.duration).toFixed(2)}s`).join(' / ')
            : '';
        this._ui.log(
            `[ ${caster === this._left ? '技能' : '敌方技能'} ]  ${caster.cfg.name} · ${def.name}`
            + (times ? `  打击点 ${times}` : ''),
        );
    }

    /**
     * 技能命中结算：把这一段打击点的 effects 逐个施加成 buff
     *
     * 这一层只做三件事：找到 buff 定义、按概率判定、决定挂给谁。
     * 伤害 / 治疗 / 控制 / 位移全部由 buff 自己带（见 buff.json）。
     */
    private _resolveSkillHit(
        caster: Fighter,
        target: Fighter,
        def: SkillDef,
        hitIndex: number,
    ): void {
        if (this._over) return;

        const hit = def.hits[hitIndex];
        if (!hit) return;

        if (hit.shake > 0) this._shake = Math.max(this._shake, hit.shake);

        const seg = def.hits.length > 1 ? `第${hitIndex + 1}段 ` : '';

        for (const ref of hit.effects) {
            const buff = BUFFS.get(ref.buff);
            if (!buff) {
                this._ui.log(`  [ 配置 ]  ${def.name} 引用了不存在的 buff "${ref.buff}"`);
                continue;
            }
            // 概率判定：没中就只在日志里留一行，方便调「30% 眩晕」这类效果
            if (ref.chance < 1 && Math.random() > ref.chance) {
                this._ui.log(`  ${def.name} ${seg}${buff.name} 未触发`);
                continue;
            }
            const recv = buff.target === 'self' ? caster : target;
            if (!recv || !recv.alive) continue;
            recv.applyBuff(buff, caster.atk, ref.stacks, ref.value);
        }
    }

    /**
     * buff 结算（瞬时伤害 / 周期跳伤 / 治疗都走这里）
     *
     * Fighter 只负责「该结算了」，扣血、飘字、判胜负都在战斗层，
     * 所以 buff 可以随便跳，不需要知道战斗流程。
     */
    private _resolveBuff(owner: Fighter, inst: BuffInstance): void {
        if (this._over || !owner.alive) return;

        const source = owner === this._left ? this._right : this._left;
        const value = Math.round(inst.value);
        if (value === 0) return;

        const color = hex(inst.def.color);
        const pos = new Vec3(owner.x, owner.headY - 30, 0);
        const srcName = source ? source.cfg.name : '';
        // 瞬时（duration=0）走完整的命中反馈，持续效果只跳数字
        const instant = inst.def.duration <= 0;

        // ---- 治疗 / 增益 ----
        if (value > 0) {
            const heal = Math.max(1, value);
            owner.hp = Math.min(owner.cfg.maxHp, owner.hp + heal);
            owner.syncBar();
            this._ui.float(pos, `+${heal}`, color, true);
            this._ui.log(
                instant
                    ? `  ${owner.cfg.name} 回复 ${heal} 生命`
                    : `  ${owner.cfg.name} 的 ${inst.def.name} 回复 ${heal} 生命`,
            );
            return;
        }

        // ---- 伤害 ----
        let dmg = -value;
        // 只有瞬时伤害吃防御减伤、浮动与暴击；dot 每跳固定，否则会被防御削成 1
        let crit = false;
        if (instant) {
            dmg = dmg * this._rand(0.92, 1.08) - owner.def * BATTLE.defenseFactor;
            crit = !!source && Math.random() < source.critRate;
            if (crit) dmg *= BATTLE.critMul;
        }
        dmg = Math.max(1, Math.round(dmg));

        owner.hp = Math.max(0, owner.hp - dmg);
        owner.syncBar();
        this._ui.float(pos, `-${dmg}`, crit ? hex('#ff8a3d') : color, crit);

        // 瞬时伤害才有受击表现与能量回复；dot 只跳数字，避免一直抽搐
        if (instant) {
            owner.playHurt();
            // 受击回能；出手方回能统一放在普攻 _resolveHit 里，
            // 否则多段技能一次能回上百能量，技能会滚雪球
            owner.energy = Math.min(BATTLE.energyMax, owner.energy + BATTLE.energyPerHurt);
            if (owner === this._left) this._ui.setEnergy(owner.energy);
        }

        this._ui.log(
            instant
                ? `  ${srcName} ${crit ? '暴击 ' : ''}命中 ${owner.cfg.name}，造成 ${dmg} 伤害`
                : `  ${owner.cfg.name} 受到 ${inst.def.name} ${dmg} 伤害`,
        );

        if (!owner.alive) {
            const winner = owner === this._left ? this._right : this._left;
            if (winner && winner.alive) this._finish(winner, owner);
        }
    }

    private _tickCooldowns(cds: number[], dt: number): void {
        for (let i = 0; i < cds.length; i++) {
            if (cds[i] > 0) cds[i] = Math.max(0, cds[i] - dt);
        }
    }

    /**
     * AI 决策：冷却、能量与射程都满足时，优先释放消耗最高的技能
     *
     * @param cds 该角色自己的技能冷却数组（左方 _leftCd / 右方 _rightCd）
     * @param isLeft 左方是「自动技能」按钮驱动的，反应比敌方 AI 快一点
     */
    private _tickAiSkill (
        caster: Fighter,
        target: Fighter,
        dt: number,
        cds: number[],
        isLeft = false,
    ): void {
        if (!caster.alive || !target.alive) return;
        if (caster.state !== FighterState.Idle) return;
        if (!caster.canCast) return;
        if (caster.cfg.skills.length === 0) return;

        if (isLeft) {
            // 自动模式几乎是「能放就放」：待机窗口只有 0.15s，节流值必须小于它
            this._aiThinkL -= dt;
            if (this._aiThinkL > 0) return;
            this._aiThinkL = 0.05;
        } else {
            this._aiThink -= dt;
            if (this._aiThink > 0) return;
            this._aiThink = 0.5;
        }

        const dist = caster.distanceTo(target);
        let best = -1;
        for (let i = 0; i < caster.cfg.skills.length; i++) {
            const s = caster.cfg.skills[i];
            if (cds[i] > 0 || caster.energy < s.energyCost) continue;
            if (dist > caster.rangeOf(s)) continue;
            if (best < 0 || s.energyCost > caster.cfg.skills[best].energyCost) best = i;
        }
        if (best < 0) return;
        this._executeSkill(caster, target, best, cds);
    }

    /**
     * 刷新左方技能栏
     *
     * 可用 = 存活 + 冷却好 + 能量够 + 距离够。
     * ★ 这里不再要求「待机状态」：普攻动作期间点击会被排队（见 _castSkill），
     *   如果按待机态置灰，按钮在绝大部分时间里都是灰的，看起来像点不动。
     */
    private _refreshSkillBar(fighter: Fighter, interactive: boolean): void {
        if (!fighter) return;
        const target = this._right;
        const states = fighter.cfg.skills.map((s, i) => ({
            usable: interactive
                && fighter.alive
                && fighter.canCast
                && this._leftCd[i] <= 0
                && fighter.energy >= s.energyCost
                && !!target
                && fighter.distanceTo(target) <= fighter.rangeOf(s),
            cooldown: this._leftCd[i] ?? 0,
            enoughEnergy: fighter.energy >= s.energyCost,
        }));
        this._ui.updateSkills(states);
    }

    /** 结算一次普通攻击命中（技能的结算走 _resolveSkillHit / _resolveBuff） */
    private _resolveHit(attacker: Fighter, target: Fighter): void {
        if (!target.alive || this._over) return;

        const crit = Math.random() < attacker.critRate;
        let dmg = attacker.atk * this._rand(0.92, 1.08) - target.def * BATTLE.defenseFactor;
        if (crit) dmg *= BATTLE.critMul;
        dmg = Math.max(1, Math.round(dmg));

        target.hp = Math.max(0, target.hp - dmg);
        target.playHurt();
        target.syncBar();

        attacker.energy = Math.min(BATTLE.energyMax, attacker.energy + BATTLE.energyPerAttack);
        target.energy = Math.min(BATTLE.energyMax, target.energy + BATTLE.energyPerHurt);

        // ---- UI 反馈 ----
        this._ui.setEnergy(this._left ? this._left.energy : 0);

        this._ui.float(
            new Vec3(target.x, target.headY - 30, 0),
            `-${dmg}`,
            crit ? hex('#ff8a3d') : hex('#ffffff'),
            crit,
        );
        this._ui.log(
            crit
                ? `  ${attacker.cfg.name} 暴击 ${target.cfg.name}，造成 ${dmg} 伤害`
                : `  ${attacker.cfg.name} 攻击 ${target.cfg.name}，造成 ${dmg} 伤害`,
        );

        this._shake = Math.max(this._shake, crit ? BATTLE.attackCritShake : BATTLE.attackShake);

        if (!target.alive) this._finish(attacker, target);
    }

    // ---------------------------------------------------------------- 结束与循环

    private _finish(winner: Fighter, loser: Fighter): void {
        this._over = true;
        // 结束时双方都停步，避免主角带着 walkTarget 继续走出画面
        this._left?.stopWalk();
        this._right?.stopWalk();
        loser.die();
        loser.syncBar();

        const heroWon = winner === this._left;

        if (this._loopMode && heroWon) {
            // ---- 循环模式：不弹窗，稍后换敌续战 ----
            this._killStreak++;
            this._ui.setStreak(this._killStreak);
            this._ui.log(`[ 击杀 ]  ${loser.cfg.name} 倒下 · 连胜 ${this._killStreak}`);
            this.scheduleOnce(() => { void this._nextRound(); }, BATTLE.loopNextDelay);
            return;
        }

        if (this._loopMode && !heroWon) {
            this._ui.log(`[ 结束 ]  连胜 ${this._killStreak} 场`);
            this._ui.showResult(
                '挑战结束',
                `连胜 ${this._killStreak} 场 · 被 ${winner.cfg.name} 击败`,
                hex('#ff6b6b'),
            );
            this.scheduleOnce(() => { this._running = false; }, 0.8);
            return;
        }

        this._ui.log(`[ 结束 ]  ${winner.cfg.name} 击败 ${loser.cfg.name}`);
        this._ui.showResult(
            heroWon ? '战斗胜利' : '战斗失败',
            `${winner.cfg.name} 击败了 ${loser.cfg.name}`,
            heroWon ? hex('#5fd08a') : hex('#ff6b6b'),
        );

        this.scheduleOnce(() => {
            this._running = false;
        }, 0.8);
    }

    /** 循环模式：主角回血 → 随机换向 → 刷新新敌人 */
    private async _nextRound(): Promise<void> {
        const L = this._left;
        if (!L || !this.isValid) return;

        // 清理上一场的敌人
        if (this._right) {
            this._right.destroy();
            this._right = null;
        }

        this._over = false;
        this._enemyActive = false;
        this._ui.hideResult();

        // 主角恢复
        L.resetHp(BATTLE.loopHealRatio);
        L.syncBar();
        L.playIdle();
        this._ui.setEnergy(L.energy);

        // 随机朝向，并往该方向走一段
        this._roamDir = (Math.random() < 0.5 ? -1 : 1) as 1 | -1;
        L.setFacing(this._roamDir);

        const enemyId = this._resolveEnemyId(this._leftId, this._rightId);
        const rightCfg = findCharacter(enemyId);

        this._ui.setLoading('下一场…');
        let data;
        try {
            data = await SpineLoader.load(rightCfg.bundlePath);
        } catch (e: any) {
            this._ui.setLoading(`敌人资源加载失败：${e && e.message ? e.message : e}`);
            return;
        }
        if (!this.isValid || !this._left) return;

        GameConfig.validateAgainstSkeleton(rightCfg.id, data);
        this._ui.setLoading('');

        // 上一场的敌人已销毁，把它的资源从缓存里释放掉
        SpineLoader.releaseExcept([L.cfg.bundlePath, rightCfg.bundlePath]);

        // 新敌人在主角行进方向的前方待命
        const spawnDist = Math.max(
            BATTLE.spawnDistance * this._gscale,
            260,
            L.cfg.attackRange * this._gscale * 1.35,
        );
        this._aggroDist = spawnDist * BATTLE.aggroRatio;

        let dir: 1 | -1 = this._roamDir;
        let enemyX = this._clampWorldX(L.x + dir * spawnDist);
        if (Math.abs(enemyX - L.x) < spawnDist * 0.85) {
            dir = (dir > 0 ? -1 : 1) as 1 | -1;
            enemyX = this._clampWorldX(L.x + dir * spawnDist);
            this._roamDir = dir;
            L.setFacing(dir);
        }

        this._right = this._bindBuffs(
            new Fighter(this._stage, rightCfg, data, dir > 0 ? -1 : 1, this._groundY, this._gscale),
        );
        this._right.placeAt(enemyX);
        this._right.setFacing(enemyX >= L.x ? -1 : 1);
        this._right.syncBar();
        this._right.cooldown = this._rand(BATTLE.firstDelayMin, BATTLE.firstDelayMax);

        const floatIdx = this._floatLayer.getSiblingIndex();
        this._right.node.setSiblingIndex(Math.max(0, floatIdx - 1));

        this._rightCd = new Array(rightCfg.skills.length).fill(0);
        this._aiThink = 1.0;

        this._ui.setFighters(this._leftId, enemyId);
        this._ui.log(`[ 第 ${this._killStreak + 1} 场 ]  ${rightCfg.name} 出现了`);
    }

    /** 循环开关（战斗中也能切） */
    private _toggleLoop(on: boolean): void {
        this._loopMode = on;
        this._ui.setLoopToggle(on);
        this._ui.setStreak(on ? this._killStreak : -1);
        this._ui.log(`[ 循环 ]  ${on ? '已开启，击杀后自动续战' : '已关闭，结束后弹窗'}`);
    }

    // ---------------------------------------------------------------- 辅助

    private _clearFighters(): void {
        if (this._left) {
            this._left.destroy();
            this._left = null;
        }
        if (this._right) {
            this._right.destroy();
            this._right = null;
        }
    }

    private _getSpeed(): number {
        return BATTLE.speedOptions[this._speedIndex] ?? 1;
    }

    private _cycleSpeed(): void {
        this._speedIndex = (this._speedIndex + 1) % BATTLE.speedOptions.length;
        this._ui.setSpeedLabel(this._getSpeed());
        this._ui.log(`[ 设置 ]  战斗速度 x${this._getSpeed()}`);
    }

    private _rand(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }
}

// 供外部按 id 查找角色（保持与原导出一致）
export type { CharacterConfig };
