/**
 * 配置表的行结构定义
 *
 * 6 张表都是「扁平行式」：一行一条记录，用 id / charId 做关联，不嵌套对象。
 *   battle.json     全局参数（键值，无行概念）
 *   character.json  角色战斗数值       主键 id
 *   spine.json      角色资源显示参数   主键 id（外键 → character.id）
 *   anim.json       动画引用           外键 charId + kind + order
 *   buff.json       buff 定义          主键 id（被 skill 的 effects 引用）
 *   skill.json      技能               外键 charId + slot
 *
 * 这里只描述「JSON 里长什么样」；运行时用的 CharacterConfig / SkillDef 在
 * BattleConfig.ts 与 SkillTypes.ts，两者由 GameConfig 做转换。
 */

/** 行式表的通用外壳 */
export interface TableSheet<T> {
    /** 表名，用于自检 */
    _table: string;
    /** 表结构版本 */
    _version: number;
    /** 说明（可选） */
    _comment?: string;
    /** 数据行 */
    rows: T[];
}

/** character.json 的一行：角色的战斗数值 */
export interface CharacterRow {
    /** 主键，与 spine.json 的 id、anim/skill 的 charId 对应 */
    id: string;
    /** 显示名 */
    name: string;
    maxHp: number;
    atk: number;
    def: number;
    /** 暴击率 0~1 */
    critRate: number;
    /** 普攻射程（两人中心距，720×1280 基准像素） */
    attackRange: number;
    /** 移动速度（px/s，720×1280 基准像素） */
    moveSpeed: number;
    /** 主题色 #rrggbb（血条 / 名字 / 选中态） */
    accent: string;
}

/** spine.json 的一行：角色的资源与显示参数 */
export interface SpineRow {
    id: string;
    /** Asset Bundle 名，缺省用 battle.json 外的默认值 'spine' */
    bundle?: string;
    /** Bundle 内路径，不含扩展名 */
    path: string;
    /** 资源基准缩放（把各角色统一到同一体高） */
    scale: number;
    /** 骨架坐标系里的对齐参考点 X（身体中轴 / 脚底中心） */
    anchorX: number;
    /** 骨架坐标系里的对齐参考点 Y（脚底） */
    anchorY: number;
    /** 头顶在骨架坐标系里的 Y（定位头顶血条与飘字） */
    headY: number;
    /**
     * 资源自身朝向是否与「标准朝右」相反
     *
     * 项目约定：facing = 1（站在左侧）时角色面朝右。少数外包资源的骨骼
     * 默认面朝左，把它置 true，渲染时会整体水平镜像。
     * 可写 true / false（也接受 1 / 0）。
     */
    flip?: boolean | number;
    /** 像素级微调（屏幕方向，不受 flip 影响） */
    offsetX?: number;
    offsetY?: number;
}

/** anim.json 的动画类别 */
export type AnimKind = 'idle' | 'run' | 'hurt' | 'attack';

/** anim.json 的一行：一个动画引用 */
export interface AnimRow {
    charId: string;
    kind: AnimKind;
    /** spine 动画名；空字符串表示该角色没有这个动作 */
    anim: string;
    /** 骨架内原始时长（秒） */
    duration: number;
    /** 仅 attack 有意义：普攻动作池的轮换顺序，升序 */
    order?: number;
}

/** buff.json 的一行：一个 buff 的定义 */
export interface BuffRow {
    /** 主键，skill.json 的 effects 里按它引用 */
    id: string;
    name: string;
    /** BUFFTYPE 的键名（仅分类，不参与行为分发） */
    buffType: string;

    /** 施加对象：self / enemy，缺省 enemy */
    target?: 'self' | 'enemy';
    /** 持续秒数；0/缺省 = 瞬时 */
    duration?: number;
    /** 周期结算间隔（秒）；与 duration 配合出 dot / hot */
    tick?: number;

    /** 数值绝对值：方向由 sign 决定，这里只写倍数（如 1.6 = 1.6 倍攻击） */
    value?: number;
    /** 数值口径：atkMul / atkFlat / maxHpRatio / flat */
    valueType?: 'atkMul' | 'atkFlat' | 'maxHpRatio' | 'flat';
    /** 结算方向：-1 伤害 / 1 治疗；缺省时按 value 的正负号 */
    sign?: -1 | 0 | 1;

    /** 属性百分比增减，例如 { "atk": 0.3, "moveSpeed": -0.4 } */
    stats?: { atk?: number; def?: number; moveSpeed?: number; critRate?: number };
    /** 控制：stun（眩晕）/ root（定身）/ silence（沉默） */
    control?: 'stun' | 'root' | 'silence';
    /** 击退距离（世界单位） */
    distance?: number;
    /** 击飞高度（世界单位），> 0 走抛物线 */
    height?: number;
    /** 位移耗时（秒） */
    moveTime?: number;

    /** 最大层数，缺省 1 */
    stackMax?: number;
    /** 叠加规则：refresh / stack / ignore，缺省 refresh */
    stackMode?: 'refresh' | 'stack' | 'ignore';

    /** 飘字与日志配色 */
    color?: string;
    /** 命中震屏强度 */
    shake?: number;
}

/** skill.json 打击点里的一项 buff 引用 */
export interface HitEffectRow {
    /** buff.json 的主键 */
    buff: string;
    /** 覆盖 buff 的 value（同一 buff 给不同技能用不同倍率） */
    value?: number;
    /** 触发概率 0~1，缺省 1 */
    chance?: number;
    /** 叠加层数，缺省 1 */
    stacks?: number;
}

/** skill.json 里的一个打击点 */
export interface HitRow {
    /** 动作进度 0~1（换算成秒 = at × duration） */
    at: number;
    /** 打击效果，按数组顺序依次施加 */
    effects?: HitEffectRow[];
    /** 这一段命中的震屏强度 */
    shake?: number;
}

/** skill.json 的一行：一个技能 */
export interface SkillRow {
    charId: string;
    /** 1..4，即 skill1..4，决定按钮顺序 */
    slot: number;
    name: string;
    /** 按钮上的短名，缺省取 name 前 2 字 */
    short?: string;
    /** 绑定的 spine 动画名 */
    anim: string;
    /** 演出时长（秒），决定播放倍速；0/缺省按动画原速 */
    duration?: number;
    /**
     * 打击点。每个打击点带一组 buff 引用 —— 技能的「做什么」全在 effects 里，
     * 技能本身只决定「第几帧打出去」。兼容旧的纯数字写法（视为一段纯伤害）。
     */
    hits?: Array<number | HitRow>;
    energyCost?: number;
    cooldown?: number;
    /** 释放时前冲距离 */
    lunge?: number;
    /** 射程覆盖（720 基准）；0/缺省沿用角色 attackRange */
    range?: number;
    /** 飘字颜色 */
    color?: string;
}

/** battle.json：扁平键值表 */
export type BattleSheet = { [key: string]: unknown };
