/**
 * 战斗配置（运行时结构 + 全局参数默认值）
 *
 * ★ 可编辑的配置表都在 assets/resources/config/ 下，扁平行式，改数值不用碰代码：
 *   - battle.json     全局战斗参数（键值，一行一个参数）
 *   - character.json  角色表：id / 名字 / 生命 / 攻击 / 防御 / 暴击 / 射程 / 移速 / 主题色
 *   - spine.json      资源表：bundle / 路径 / 缩放 / 锚点 / headY / 像素微调
 *   - anim.json       动画表：charId + kind(idle|run|hurt|attack) + 动画名 + 时长
 *   - buff.json       buff 表：一行一个效果模板（伤害/治疗/持续/属性/控制/位移）
 *   - skill.json      技能表：charId + slot + 绑定的动画 + 打击点（每段引用 buff）
 *
 * 这 6 张表统一由 GameConfig 加载与校验，加载完成后会填充下面的 CHARACTERS、
 * BUFFS，并把 battle.json 的值覆盖到 BATTLE 上。**代码里不再有角色硬编码。**
 *
 * 各角色的真实动画清单见 .workbuddy/memory/ 的工作日志，或直接看 anim.json。
 */

import type { BuffDef } from './BuffTypes';
import type { SkillDef } from './SkillTypes';

export interface AttackAnim {
    /** 动画名 */
    name: string;
    /** 原始时长（秒），用于计算播放倍速 */
    duration: number;
}

export interface CharacterConfig {
    /** 资源目录名（主键，与配置表的 id / charId 对应） */
    id: string;
    /** 显示名 */
    name: string;
    /** Asset Bundle(spine) 内的资源路径，不含扩展名 */
    bundlePath: string;

    /** 待机动画 */
    idle: string;
    idleDuration: number;
    /** 移动动画 */
    run: string;
    runDuration: number;
    /** 普通攻击动作池（按 anim.json 的 order 排序，随机取一个） */
    attackPool: AttackAnim[];
    /** 受击动画；空字符串表示该角色无受击动作，仅做闪白与位移 */
    hurt: string;
    hurtDuration: number;

    maxHp: number;
    atk: number;
    def: number;
    /** 暴击率 */
    critRate: number;
    /**
     * 普攻射程：**两人中心距**的阈值（720×1280 基准像素，运行时乘屏幕缩放）
     * 双方各自按自己的射程判定：中心距 ≤ 射程即可出手，射程远的会先停步先开打。
     * 数值需大于两人半宽之和（characterScale=1 时角色宽约 300~460），否则会贴在一起。
     * 技能可在 skill.json 里用 range 单独覆盖。
     */
    attackRange: number;
    /** 移动速度（px/s，720×1280 基准，运行时乘屏幕缩放） */
    moveSpeed: number;

    /** 主题色（血条 / 名字 / 选中态） */
    accent: string;

    // ---- 显示参数（来自 spine.json） ----

    /** 缩放倍数 */
    displayScale: number;
    /** 骨架坐标系中的对齐参考点 X（身体中轴），渲染时会平移到站位点 */
    anchorX: number;
    /** 骨架坐标系中的对齐参考点 Y（脚底），渲染时会平移到地面 */
    anchorY: number;
    /** 头顶在骨架坐标系中的 Y，用于定位血条与飘字 */
    headY: number;
    /**
     * 资源自身朝向是否与标准相反（spine.json 的 flip）
     *
     * 标准：facing = 1（左侧站位）时应面朝右。为 true 时渲染整体水平镜像。
     * 锚点围绕脚底中心对称翻转，因此 **不需要** 跟着改 anchorX。
     */
    flipX: boolean;
    /** 像素级微调（屏幕方向，不受朝向翻转影响） */
    offsetX: number;
    offsetY: number;

    /** 技能列表（skill1 / skill2 / …，按 slot 升序），来自 skill.json */
    skills: SkillDef[];
}

/**
 * 全局战斗参数
 *
 * 这里的值是**默认值**，运行时会被 resources/config/battle.json 覆盖
 * （只覆盖同名键，写错键名会在控制台告警）。
 * 改完 JSON 不用改这个文件；这里保留默认值是为了配置加载失败时仍能跑。
 */
export const BATTLE = {
    // ---- 开局阵容 ----

    /**
     * 主角默认角色 id（左侧）
     *
     * 必须是 character.json 里存在的 id，找不到时回退角色表第一项。
     */
    defaultHeroId: 'lvbu',
    /**
     * 敌方默认角色 id（右侧）
     *
     * 填 'random' 表示每场随机（排除主角），填具体 id 则固定。找不到时回退角色表第二项。
     */
    defaultEnemyId: 'qiangbing',

    // ---- 场景显示 ----

    /**
     * ★ 角色在战斗场景中的整体缩放倍率
     *
     * 与角色自身的 displayScale（spine.json，用于把各角色统一到同一体高）相乘。
     * **只想把战斗里的角色调大/调小，就改这一个值。**
     *
     * 参考：0.8~1.0 完全不出屏；1.0~1.15 仅飘带/光效的透明边被裁；
     * 1.2 以上会被实心部位裁切（角色骨架本身较宽）。
     */
    characterScale: 0.5,

    /** 地面线整体上移量（px，正数 = 上移）。角色位置偏低时加大这个值 */
    groundOffsetY: 60,

    // ---- 走位与射程 ----

    /**
     * 战斗世界宽度（屏宽的倍数，1 = 与屏幕等宽、不会滚动）
     * 2.4 表示横向可走约 2.4 屏，镜头会跟随主角平移。
     */
    worldWidthScreens: 2.4,
    /** 敌人刷新在主角前方的距离（px，乘屏幕缩放）；非循环模式由 approachTime 推导 */
    spawnDistance: 900,
    /** 敌人激活比例：中心距 ≤ 刷新距离 × 该值 时敌人开始靠近（0.8 即走完 20% 距离被察觉） */
    aggroRatio: 0.8,
    /** 镜头跟随死区半宽（px）：主角在死区内移动时镜头不动 */
    camDeadZone: 90,
    /** 非循环模式：主角向右走多久遇到敌人（秒） */
    approachTime: 2.5,

    // ---- 循环战斗 ----

    /** 击杀后到下一场开始的间隔（秒） */
    loopNextDelay: 1.0,
    /** 循环模式主角击杀后回复的血量比例（1 = 回满） */
    loopHealRatio: 1,
    /** 循环模式主角每场结束后随机走动的距离（px） */
    loopRoamDistance: 380,

    // ---- 头顶血条 ----

    /** 头顶血条宽度（px，720 基准） */
    headBarWidth: 168,
    /** 头顶血条相对头顶再向上的偏移（px，720 基准） */
    headBarOffsetY: 30,

    // ---- 节奏 ----

    /** 普攻动作播完后到下一次可出手的间隔（秒，1 倍速基准） */
    attackInterval: 0.15,
    /** 普攻动作压缩到的目标时长（秒）；与 attackInterval 相加即普攻总周期 */
    attackTargetTime: 0.65,
    /** 技能未填 duration 时的兜底演出时长（秒） */
    skillTargetTime: 1.45,
    /** 受击硬直（秒） */
    hurtLockTime: 0.32,
    /** 技能霸体：技能演出期间受击不硬直、不打断动作（只闪白吃伤害） */
    skillSuperArmor: true,
    /** 命中判定点：动作进度的百分比 */
    hitProgress: 0.45,
    /** 每次普攻获得能量 */
    energyPerAttack: 16,
    /** 每次受击获得能量 */
    energyPerHurt: 10,
    energyMax: 100,
    /** 暴击倍率 */
    critMul: 1.75,
    /** 防御减伤系数 */
    defenseFactor: 0.5,
    /** 普攻命中的震屏强度（px，填 0 关闭；单位与 skill.json 的 shake 一致） */
    attackShake: 0,
    /** 普攻暴击命中的震屏强度（px，填 0 关闭） */
    attackCritShake: 8,
    /** 可选的战斗速度（升序，第一个为默认） */
    speedOptions: [0.5, 1, 2, 3],
    /** 开局首个动作的随机延迟范围 */
    firstDelayMin: 0.35,
    firstDelayMax: 1.0,
};

/**
 * 角色池
 *
 * **加载前是空数组**，由 GameConfig.load() 从 character / spine / anim / skill
 * 四张表组装后原地填充。任何依赖角色池的界面都必须在加载完成后再创建。
 */
export const CHARACTERS: CharacterConfig[] = [];

/**
 * buff 定义表
 *
 * **加载前是空 Map**，由 GameConfig.load() 从 buff.json 填充。
 * 技能的打击点按 id 引用这里的定义；引用不到会在控制台与战斗日志里告警。
 */
export const BUFFS = new Map<string, BuffDef>();

/**
 * 按 id 查找角色配置
 *
 * 找不到时回退到角色池第一个，保证调用方不用判空。
 * 注意：配置未加载时角色池为空，本函数会返回 undefined，
 * 所以调用前必须确保 `GameConfig.ready`。
 */
export function findCharacter (id: string): CharacterConfig {
    return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}
