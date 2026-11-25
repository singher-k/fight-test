/**
 * 配置表的行结构定义
 *
 * ⚠ 本文件由 config-templates/gen-templates.py 自动生成，请勿手改。
 *   要改字段：编辑 config-templates/schema.py，然后重跑生成器。
 *
 * 这里只描述「JSON 里长什么样」。运行时用的 CharacterConfig / SkillDef 在
 * BattleConfig.ts 与 SkillTypes.ts，两者由 GameConfig 解析转换而来。
 *
 * 数据文件：assets/resources/config/*.json
 */

/** anim.json 的动画类别 */
export type AnimKind = 'idle' | 'run' | 'hurt' | 'attack';

/** character.json 的一行：角色的战斗数值 */
export interface CharacterRow {
    /**
     * 角色id
     * 主键。spine.json 用同一个 id；anim / skill / hit 里叫 charId
     */
    id: string;
    /** 显示名 */
    name: string;
    /** 最大生命 */
    maxHp: number;
    /** 攻击力 */
    atk: number;
    /** 防御力 */
    def: number;
    /**
     * 暴击率(万分比)
     * 万分比：1000 = 10%。GameConfig 读入时自动 /10000
     */
    critRate: number;
    /**
     * 普攻射程
     * 两人中心距，720×1280 基准像素
     */
    attackRange: number;
    /**
     * 移动速度
     * px/s，720×1280 基准像素
     */
    moveSpeed: number;
    /**
     * 主题色
     * #rrggbb，用于血条 / 名字 / 选中态
     */
    accent: string;
}

/** spine.json 的一行：角色的资源与显示参数 */
export interface SpineRow {
    /**
     * 角色id
     * 外键：character.json 的 id
     */
    id: string;
    /**
     * 资源包
     * Asset Bundle 名，缺省 'spine'
     */
    bundle?: string;
    /**
     * 资源路径
     * Bundle 内路径，不含扩展名
     */
    path: string;
    /**
     * 基准缩放(万分比)
     * 万分比：3160 = 0.316。把各角色统一到同一体高
     */
    scale: number;
    /**
     * 锚点X
     * 骨架坐标系里的对齐参考点 X
     */
    anchorX: number;
    /**
     * 锚点Y
     * 骨架坐标系里的对齐参考点 Y（脚底）
     */
    anchorY: number;
    /**
     * 头顶Y
     * 头顶在骨架坐标系里的 Y，用于定位血条与飘字
     */
    headY: number;
    /**
     * 水平翻转
     * 资源自身朝向与「标准朝右」相反时填 true（也可写 1/0），渲染时整体镜像
     */
    flip?: boolean | number;
    /**
     * 微调X
     * 像素级微调，不受 flip 影响
     */
    offsetX?: number;
    /**
     * 微调Y
     * 像素级微调，不受 flip 影响
     */
    offsetY?: number;
}

/** anim.json 的一行：一个动画引用 */
export interface AnimRow {
    /**
     * 角色id
     * 外键：character.json 的 id
     */
    charId: string;
    /**
     * 动画类别
     * idle 待机 / run 移动 / hurt 受击 / attack 普攻
     */
    kind: AnimKind;
    /**
     * 动画名
     * Spine 动画名；空字符串表示该角色没有这个动作
     */
    anim: string;
    /**
     * 原始时长(毫秒)
     * 毫秒：1500 = 1.5 秒。骨架内原始时长，用于算播放倍速
     */
    duration: number;
    /**
     * 轮换顺序
     * 仅 attack 有意义：普攻动作池的轮换顺序，升序；缺省按行号
     */
    order?: number;
}

/** buff.json 的一行：一个 buff 的定义 */
export interface BuffRow {
    /**
     * buffid
     * 主键，hit.json 的 e1..e4 效果格里按它引用
     */
    id: string;
    /**
     * 显示名
     * 飘字与日志用
     */
    name: string;
    /**
     * 分类
     * BUFFTYPE 的键名，仅做标签，不参与行为分发
     */
    buffType: string;
    /**
     * 施加对象
     * 缺省 enemy
     */
    target?: 'self' | 'enemy';
    /**
     * 持续时长(毫秒)
     * 毫秒：1500 = 1.5 秒。0 / 缺省 = 瞬时
     */
    duration?: number;
    /**
     * 结算间隔(毫秒)
     * 毫秒：500 = 0.5 秒。与 duration 配合出 dot / hot
     */
    tick?: number;
    /**
     * 数值(万分比)
     * 万分比：16000 = 1.6 倍攻击。只写绝对值，方向由 sign 决定
     */
    value?: number;
    /**
     * 数值口径
     * 攻击力百分比 / 固定攻击力 / 目标最大生命百分比 / 固定数值
     */
    valueType?: 'atkMul' | 'atkFlat' | 'maxHpRatio' | 'flat';
    /**
     * 结算方向
     * -1 伤害 / 1 治疗；0 或缺省时退回按 value 的正负号
     */
    sign?: -1 | 0 | 1;
    /**
     * 属性增减(万分比)
     * 每项都是万分比：{ "atk": 3000, "moveSpeed": -4000 } = 攻击 +30%、移速 -40%
     */
    stats?: { atk?: number; def?: number; moveSpeed?: number; critRate?: number };
    /**
     * 控制类型
     * 眩晕 / 定身 / 沉默
     */
    control?: 'stun' | 'root' | 'silence';
    /**
     * 击退距离
     * 世界单位（整数像素，不是万分比）
     */
    distance?: number;
    /**
     * 击飞高度
     * 世界单位，> 0 走抛物线
     */
    height?: number;
    /**
     * 位移耗时(毫秒)
     * 毫秒：350 = 0.35 秒
     */
    moveTime?: number;
    /**
     * 最大层数
     * 缺省 1
     */
    stackMax?: number;
    /**
     * 叠加规则
     * 缺省 refresh
     */
    stackMode?: 'refresh' | 'stack' | 'ignore';
    /**
     * 配色
     * 飘字与日志配色 #rrggbb
     */
    color?: string;
    /**
     * 震屏强度(万分比)
     * 万分比：6000 = 6。命中震屏
     */
    shake?: number;
}

/** skill.json 的一行：一个技能 */
export interface SkillRow {
    /**
     * 角色id
     * 必须在 character.json 里存在
     */
    charId: string;
    /**
     * 技能槽位
     * 1~4，同一角色内不能重复。按钮顺序由本表行顺序决定，不是这个数值
     */
    slot: number;
    /**
     * 技能名
     * 显示在按钮与日志；缺省用「技能N」
     */
    name?: string;
    /**
     * 按钮短名
     * 缺省取 name 前 2 字
     */
    short?: string;
    /**
     * 动画名
     * 留空则整行被跳过，技能不会出现
     */
    anim: string;
    /**
     * 演出时长(毫秒)
     * 毫秒：1500 = 1.5 秒。决定播放倍速；0 / 缺省按动画原速
     */
    duration?: number;
    /**
     * 能量消耗
     * 0~100
     */
    energyCost?: number;
    /**
     * 冷却时长(毫秒)
     * 毫秒：2500 = 2.5 秒。从动作播完开始计时（不是按下按钮开始）
     */
    cooldown?: number;
    /**
     * 前冲距离
     * 当前运行时不生效，字段保留备用
     */
    lunge?: number;
    /**
     * 射程
     * 720 基准；0 / 缺省沿用角色的 attackRange
     */
    range?: number;
    /**
     * 主题色
     * #rrggbb
     */
    color?: string;
}

/** hit.json 的一行：一个打击点 */
export interface HitRow {
    /**
     * 角色id
     * 外键：character.json 的 id
     */
    charId: string;
    /**
     * 技能槽位
     * 外键：skill.json 同角色的 slot
     */
    slot: number;
    /**
     * 段序号
     * 1 起，缺省按行序自动编号。同一 charId + slot 下不能重复
     */
    hit?: number;
    /**
     * 打击时刻(毫秒)
     * 毫秒：距技能动画开始的时刻，765 = 0.765 秒。上限是该技能的演出时长（skill.duration；填 0 时按 battle.skillTargetTime），超出会被钳到动画末尾
     */
    at: number;
    /**
     * 震屏强度(万分比)
     * 万分比：6000 = 6。这一段命中的震屏，0 / 缺省 = 不震
     */
    shake?: number;
    /**
     * 效果1
     * 语法 <buffId>[:value][@chance][#stacks]，value 与 chance 用万分比，如 dmg:16000、slow@4000
     */
    e1?: string;
    /**
     * 效果2
     * 必须紧接 e1 填，中间不能空
     */
    e2?: string;
    /** 效果3 */
    e3?: string;
    /**
     * 效果4
     * 一段最多 4 组，e5 及以后不存在
     */
    e4?: string;
}
