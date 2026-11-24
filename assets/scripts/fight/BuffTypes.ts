/**
 * buff 的类型定义
 *
 * 设计原则：**buff.json 里的字段决定行为，buffType 只做分类标签**。
 * 这样枚举可以随时增删而不影响运行时（枚举为空时跳过校验）。
 *
 * 行为判定顺序（applyBuff 里实现）：
 *   1. distance / height > 0      → 位移（击退 / 击飞），立即生效
 *   2. control 非空               → 控制（眩晕 / 定身 / 沉默），持续 duration
 *   3. stats 非空                 → 属性增减（攻/防/移速/暴击），持续 duration
 *   4. duration <= 0             → 立即结算一次（符号见 sign）
 *   5. duration > 0 且 tick > 0   → 周期结算（hot / dot）
 *   6. duration > 0 且 tick <= 0  → 到期时结算一次（延迟伤害 / 延迟治疗）
 *
 * ★ 方向（伤害 / 治疗）由 sign 决定，不看 value 的正负：
 *   sign = -1 → 伤害，sign = 1 → 治疗，sign 缺省(0) 才退回「正 = 治疗，负 = 伤害」。
 *   这样 value 只写绝对值倍数（如 dmg 的 1.6），配错了也不会把伤害变成回血。
 *
 * 一个 buff 可以同时命中多条（例如「火焰冲击」= 立即伤害 + 灼烧 + 击退）。
 */

/**
 * buff 类型枚举（分类标签）
 *
 * ★ 具体成员由策划自行补充，代码不依赖这些成员：运行时行为由 buff.json 的
 *   其它列决定，这里只用于分类、筛选与配置校验。
 *   枚举为空时 GameConfig 会跳过 buffType 的合法性校验。
 *
 * 参考写法（需要时取消注释并调整）：
 *   Buff = 'buff',          // 增益
 *   Debuff = 'debuff',      // 减益
 *   Dot = 'dot',            // 持续伤害
 *   Hot = 'hot',            // 持续治疗
 *   Control = 'control',    // 控制
 *   Displace = 'displace',  // 位移
 */
// eslint-disable-next-line @typescript-eslint/no-empty-enum
export enum BUFFTYPE {
    // 待补充
}

/** buff 的数值口径 */
export type BuffValueType =
    /** 按施加者攻击力的百分比（1 = 一倍攻击） */
    | 'atkMul'
    /** 固定攻击力数值 */
    | 'atkFlat'
    /** 按承受者最大生命的百分比 */
    | 'maxHpRatio'
    /** 固定数值 */
    | 'flat';

/** 控制类型 */
export type BuffControlKind =
    /** 眩晕：不能移动、不能普攻、不能放技能 */
    | 'stun'
    /** 定身：不能移动，但可以攻击 */
    | 'root'
    /** 沉默：不能放技能，但可以移动与普攻 */
    | 'silence';

/** 叠加规则 */
export type BuffStackMode =
    /** 刷新剩余时间（默认） */
    | 'refresh'
    /** 叠加层数，数值按层数放大 */
    | 'stack'
    /** 已存在时只刷新时间、不叠加（多段位移防抽动用它） */
    | 'ignore';

/** buff 的施加对象 */
export type BuffTarget = 'self' | 'enemy';

/** 属性增减（百分比，0.3 = +30%，-0.3 = -30%） */
export interface BuffStats {
    atk: number;
    def: number;
    moveSpeed: number;
    critRate: number;
}

/** buff.json 解析后的运行时定义 */
export interface BuffDef {
    /** 主键，skill.json 的 effects 里按它引用 */
    id: string;
    name: string;
    /** BUFFTYPE 的键名（仅分类，不参与分发） */
    buffType: string;

    /** 施加给谁 */
    target: BuffTarget;
    /** 持续秒数；<= 0 表示瞬时 */
    duration: number;
    /** 周期结算间隔（秒）；> 0 才按 dot / hot 跳 */
    tick: number;

    /**
     * 数值绝对值（方向由 sign 决定，见上）
     * valueType 负责换算成实际数值：atkMul 乘施加者攻击力，maxHpRatio 乘承受者最大生命
     */
    value: number;
    valueType: BuffValueType;
    /**
     * 结算方向：-1 伤害 / 1 治疗 / 0 未指定（退回 value 的正负号）
     * 有位移、控制、属性增减的 buff 不需要它（那些不结算数值）
     */
    sign: number;

    /** 属性增减 */
    stats: BuffStats;
    /** 控制类型，空字符串表示不控制 */
    control: BuffControlKind | '';
    /** 击退距离（世界单位，正 = 沿施法者朝向推开） */
    distance: number;
    /** 击飞高度（世界单位，> 0 走抛物线） */
    height: number;
    /** 位移耗时（秒） */
    moveTime: number;

    stackMax: number;
    stackMode: BuffStackMode;

    /** 飘字 / 日志配色 */
    color: string;
    /** 命中震屏强度 */
    shake: number;
}

/** 一个挂在单位身上的 buff 实例 */
export interface BuffInstance {
    def: BuffDef;
    /** 每次结算的数值（已乘层数，负 = 伤害） */
    value: number;
    /** 施加瞬间的攻击力快照（atkMul 口径用） */
    sourceAtk: number;
    /** 剩余秒数 */
    remain: number;
    /** 总时长（画进度条用） */
    duration: number;
    /** 当前层数 */
    stacks: number;
    /** 距下一跳的剩余秒数 */
    tickLeft: number;
}

/** skill.json 里一个打击点 */
export interface HitPoint {
    /** 动作进度 0~1，换算成秒 = at × duration */
    at: number;
    /** 这一段打出去的所有效果 */
    effects: BuffRef[];
    /** 这一段命中的震屏强度（0 = 不震） */
    shake: number;
}

/** 打击点里的一个 buff 引用 */
export interface BuffRef {
    /** buff.json 的主键 */
    buff: string;
    /** 覆盖 buff 的默认 value；NaN 表示用 buff 表里的值 */
    value: number;
    /** 触发概率 0~1 */
    chance: number;
    /** 叠加层数 */
    stacks: number;
}
