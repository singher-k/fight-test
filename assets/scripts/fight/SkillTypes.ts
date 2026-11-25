/**
 * 技能与动画的数据结构定义
 *
 * 独立的纯类型文件：BattleConfig / Fighter / BattleUI / BattleManager 都从这里取类型，
 * 避免与 GameConfig（加载器）形成循环依赖。
 *
 * ★ buff 化设计
 *   技能只负责「什么时候打出去」，具体效果全部由打击点引用的 buff 决定：
 *     skill.json  hits[{ at, effects:[{ buff, value }] }]
 *     buff.json   一行一个效果模板（伤害 / 治疗 / 持续 / 属性 / 控制 / 位移）
 *   因此 SkillDef 里不再有 damageMul / healRatio 这类数值字段。
 */

import type { HitPoint } from './BuffTypes';

/** 一个 spine 动画引用 */
export interface AnimRef {
    /** spine 动画名 */
    name: string;
    /** 该动画在 skeleton 内的原始时长（秒） */
    duration: number;
}

/** 技能的主要作用（只用于按钮文案与颜色，不参与结算） */
export type SkillType = 'damage' | 'heal';

/**
 * 一个技能定义（对应 JSON 里的 skill1 / skill2 / skill3 / skill4）
 */
export interface SkillDef {
    /** skill1 / skill2 … */
    id: string;
    /** 完整技能名 */
    name: string;
    /** 按钮上的短名（2 字） */
    short: string;
    /** ★ 绑定的 spine 动画名 */
    animation: string;
    /** 演出时长（秒），决定播放倍速；0 表示按动画原速 */
    duration: number;

    /**
     * ★ 打击点（已按 at 升序）
     *
     * 每段的 `at` 是动作进度 0~1，运行时换算成秒 = at × duration；
     * ★ 配置表 hit.json 里填的是**整数毫秒**（距动画开始的时刻），由
     *   GameConfig 按 at_ms / duration_ms 换成这里的 0~1，业务代码不用管单位。
     * 每段的 `effects` 是该段打出去的所有 buff —— 伤害、治疗、控制、位移都在里面。
     */
    hits: HitPoint[];

    /** 释放消耗的能量 */
    energyCost: number;
    /** 冷却秒数 */
    cooldown: number;
    /**
     * 释放时前冲距离
     * ★ 当前运行时**不生效**（playSkill 里已关闭）：侧视角下前冲-回位会被读成
     *   「人物左右晃动」。字段保留供以后做可选表演参数，配了也不会动。
     */
    lunge: number;
    /**
     * 射程覆盖（720×1280 基准像素）
     * 0 / 未填 → 使用角色的 attackRange；技能比普攻更远/更近时填这里。
     */
    range: number;
    /** 飘字颜色（#rrggbb） */
    color: string;
    /** 主要作用：以治疗为主 vs 以伤害为主（按钮文案用） */
    type: SkillType;
}
