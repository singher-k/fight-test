import { JsonAsset, resources, sp } from 'cc';
import { BATTLE, BUFFS, CHARACTERS, CharacterConfig } from './BattleConfig';
import {
    AnimRow, BuffRow, CharacterRow, HitRow, SkillRow, SpineRow,
} from './ConfigTypes';
import { BUFFTYPE, BuffDef, BuffRef, BuffStackMode, BuffValueType, HitPoint } from './BuffTypes';
import { AnimRef, SkillDef } from './SkillTypes';
import { SpineLoader } from './SpineLoader';

/** resources 内的配置目录 */
const DIR = 'config';

/** 组成全套配置的 6 张表（顺序与报错提示一致） */
export const TABLE_FILES = ['battle', 'character', 'spine', 'anim', 'buff', 'skill'] as const;

const DEFAULT_BUNDLE = 'spine';

function num (v: unknown, fallback: number): number {
    const n = typeof v === 'number' ? v : parseFloat(v as string);
    return Number.isFinite(n) ? n : fallback;
}

function clamp (v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function str (v: unknown, fallback: string): string {
    return typeof v === 'string' && v.length > 0 ? v : fallback;
}

const VALUE_TYPES: BuffValueType[] = ['atkMul', 'atkFlat', 'maxHpRatio', 'flat'];
const STACK_MODES: BuffStackMode[] = ['refresh', 'stack', 'ignore'];

function valueTypeOf (v: unknown): BuffValueType {
    return VALUE_TYPES.indexOf(v as BuffValueType) >= 0 ? (v as BuffValueType) : 'atkMul';
}

function stackModeOf (v: unknown): BuffStackMode {
    return STACK_MODES.indexOf(v as BuffStackMode) >= 0 ? (v as BuffStackMode) : 'refresh';
}

/** sign 只接受 -1 / 1，其余（含缺省、0、写错）一律 0 = 按 value 正负号 */
function signOf (v: unknown): number {
    const n = num(v, 0);
    if (n <= -0.5) return -1;
    if (n >= 0.5) return 1;
    return 0;
}

function controlOf (v: unknown): 'stun' | 'root' | 'silence' | '' {
    return v === 'stun' || v === 'root' || v === 'silence' ? v : '';
}

/** 读取一张 JSON 表；失败时 reject 带具体路径，方便直接定位 */
function loadSheet (name: string): Promise<any> {
    const path = `${DIR}/${name}`;
    return new Promise<any>((resolve, reject) => {
        resources.load(path, JsonAsset, (err, asset) => {
            if (err || !asset) {
                reject(new Error(`resources/${path}.json 加载失败：${err ? err.message : '资源不存在'}`));
                return;
            }
            resolve((asset as JsonAsset).json);
        });
    });
}

/** 从表里取 rows，兼容「直接是数组」和「{rows:[...]}」两种写法 */
function rowsOf (sheet: any, table: string): any[] {
    if (Array.isArray(sheet)) return sheet;
    if (sheet && Array.isArray(sheet.rows)) return sheet.rows;
    throw new Error(`${table}.json 缺少 rows 数组`);
}

/**
 * 配置总管
 *
 * 一次并行加载 6 张扁平表，做完整性与外键校验，然后组装出运行时的
 * `CHARACTERS`（角色池）与覆盖 `BATTLE`（全局参数）。
 *
 * 加载顺序很重要：`CHARACTERS` 在加载完成前是空数组，所以 BattleUI 等
 * 依赖角色池的东西必须在 `GameConfig.load()` 之后创建。
 */
export class GameConfig {
    private static _loading: Promise<boolean> | null = null;
    private static _ready = false;
    private static _error = '';
    private static _warnings: string[] = [];

    /** 是否已成功加载 */
    public static get ready (): boolean {
        return GameConfig._ready;
    }

    /** 加载失败时的错误描述（供 UI 提示） */
    public static get error (): string {
        return GameConfig._error;
    }

    /** 解析/校验过程中的告警 */
    public static get warnings (): string[] {
        return GameConfig._warnings;
    }

    /** 加载全套配置（幂等，重复调用复用同一个 Promise） */
    public static load (): Promise<boolean> {
        if (GameConfig._ready) return Promise.resolve(true);
        if (GameConfig._loading) return GameConfig._loading;

        GameConfig._loading = GameConfig._loadAll();
        return GameConfig._loading;
    }

    /**
     * 用真实骨架内的动画名自检当前角色配置，把写错的动画名提前暴露出来。
     * 取不到动画列表时静默跳过。
     */
    public static validateAgainstSkeleton (id: string, data: sp.SkeletonData): void {
        const cfg = CHARACTERS.find((c) => c.id === id);
        if (!cfg) return;

        const names = GameConfig.getSkeletonAnimations(data);
        if (names.length === 0) return;

        const missing: string[] = [];
        const check = (animName: string, label: string) => {
            if (animName && names.indexOf(animName) < 0) missing.push(`${label}="${animName}"`);
        };
        check(cfg.idle, '待机');
        check(cfg.run, '移动');
        check(cfg.hurt, '受击');
        cfg.attackPool.forEach((a, i) => check(a.name, `普攻${i + 1}`));
        cfg.skills.forEach((s) => check(s.animation, s.id));

        if (missing.length > 0) {
            const msg = `[${id}] 动画名不存在：${missing.join('、')}；骨架实际动画：${names.join(', ')}`;
            GameConfig._warnings.push(msg);
            console.warn('[GameConfig]', msg);
        }
    }

    /** 尽力从 SkeletonData 中取出动画名列表（不同版本结构不同，取不到返回空） */
    public static getSkeletonAnimations (data: sp.SkeletonData): string[] {
        try {
            const names = SpineLoader.getAnimationNames(data);
            if (names.length > 0) return names;
        } catch (e) { /* 忽略 */ }

        try {
            const anyData: any = data as any;
            const json = anyData.skeletonJson ?? anyData._skeletonJson ?? null;
            const obj = typeof json === 'string' ? JSON.parse(json) : json;
            if (obj && obj.animations) return Object.keys(obj.animations);
        } catch (e) { /* 忽略 */ }

        return [];
    }

    // ---------------------------------------------------------------- 内部

    private static async _loadAll (): Promise<boolean> {
        try {
            const [battle, character, spine, anim, buff, skill] = await Promise.all([
                loadSheet('battle'),
                loadSheet('character'),
                loadSheet('spine'),
                loadSheet('anim'),
                loadSheet('buff'),
                loadSheet('skill'),
            ]);

            GameConfig._warnings.length = 0;
            GameConfig._parseBattle(battle);
            // buff 必须先解析：skill 的打击点要按 id 引用它做校验
            GameConfig._parseBuffs(buff);
            GameConfig._build(battle, character, spine, anim, skill);

            GameConfig._ready = CHARACTERS.length > 0;
            GameConfig._error = GameConfig._ready ? '' : '角色表为空，请检查 character.json';

            console.log(
                `[GameConfig] 已加载 ${CHARACTERS.length} 个角色 / `
                + `${GameConfig._countSkills()} 个技能 / ${BUFFS.size} 个 buff`,
            );
            // 告警逐条打印，方便直接在控制台定位是哪张表哪一行
            for (const w of GameConfig._warnings) console.warn('[GameConfig]', w);
            return GameConfig._ready;
        } catch (e: any) {
            GameConfig._ready = false;
            GameConfig._error = e && e.message ? e.message : String(e);
            console.error('[GameConfig]', GameConfig._error);
            return false;
        }
    }

    /**
     * buff.json → BUFFS
     *
     * 只做「结构归一化 + 明显错误提示」，行为判定留给运行时（见 BuffTypes 注释）。
     */
    private static _parseBuffs (sheet: any): void {
        let rows: BuffRow[] = [];
        try {
            rows = rowsOf(sheet, 'buff');
        } catch (e: any) {
            GameConfig._warnings.push(e.message);
            BUFFS.clear();
            return;
        }

        BUFFS.clear();
        // 枚举为空时跳过 buffType 校验（由使用方自行补充成员）
        const typeKeys = Object.keys(BUFFTYPE).filter((k) => Number.isNaN(Number(k)));

        rows.forEach((r, i) => {
            if (!r || !r.id) { GameConfig._warnings.push(`buff.json 第 ${i + 1} 行没有 id，已跳过`); return; }
            if (BUFFS.has(r.id)) { GameConfig._warnings.push(`buff.json 的 id "${r.id}" 重复，取第一行`); return; }

            const s = r.stats ?? {};
            const def: BuffDef = {
                id: r.id,
                name: str(r.name, r.id),
                buffType: str(r.buffType, ''),
                target: r.target === 'self' ? 'self' : 'enemy',
                duration: Math.max(0, num(r.duration, 0)),
                tick: Math.max(0, num(r.tick, 0)),
                value: num(r.value, 0),
                valueType: valueTypeOf(r.valueType),
                sign: signOf(r.sign),
                stats: {
                    atk: num(s.atk, 0),
                    def: num(s.def, 0),
                    moveSpeed: num(s.moveSpeed, 0),
                    critRate: num(s.critRate, 0),
                },
                control: controlOf(r.control),
                distance: num(r.distance, 0),
                height: Math.max(0, num(r.height, 0)),
                moveTime: Math.max(0.05, num(r.moveTime, 0.35)),
                stackMax: Math.max(1, Math.floor(num(r.stackMax, 1))),
                stackMode: stackModeOf(r.stackMode),
                color: str(r.color, '#ffffff'),
                shake: num(r.shake, 0),
            };

            if (typeKeys.length > 0 && def.buffType && typeKeys.indexOf(def.buffType) < 0) {
                GameConfig._warnings.push(
                    `buff "${def.id}" 的 buffType "${def.buffType}" 不在 BUFFTYPE 枚举里，`
                    + `可用值：${typeKeys.join(' / ')}`,
                );
            }
            if (def.duration > 0 && def.tick > 0 && def.tick > def.duration) {
                GameConfig._warnings.push(
                    `buff "${def.id}" 的 tick(${def.tick}s) 大于 duration(${def.duration}s)，永远不会跳一次`,
                );
            }
            if (def.duration <= 0 && def.tick > 0) {
                GameConfig._warnings.push(`buff "${def.id}" 填了 tick 但 duration 为 0，周期结算不会生效`);
            }
            const idle = def.duration <= 0
                && def.value === 0
                && !def.control
                && def.distance === 0
                && def.height === 0
                && def.stats.atk === 0 && def.stats.def === 0
                && def.stats.moveSpeed === 0 && def.stats.critRate === 0;
            if (idle) GameConfig._warnings.push(`buff "${def.id}" 没有任何生效字段，挂上去不会有任何效果`);

            BUFFS.set(r.id, def);
        });
    }

    /** battle.json：只覆盖 BATTLE 里已存在的键，写错键名会告警而不是悄悄生效 */
    private static _parseBattle (sheet: any): void {
        if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) {
            GameConfig._warnings.push('battle.json 不是键值对象，已全部使用内置默认值');
            return;
        }
        const target = BATTLE as any;

        for (const key of Object.keys(sheet)) {
            if (key.startsWith('_')) continue;
            const v = sheet[key];

            if (!(key in target)) {
                GameConfig._warnings.push(`battle.json 的 "${key}" 不是已知参数，已忽略`);
                continue;
            }

            const cur = target[key];
            if (Array.isArray(cur)) {
                if (Array.isArray(v) && v.length > 0) {
                    target[key] = v.map((x: any) => num(x, 0)).filter((x: number) => x > 0);
                } else {
                    GameConfig._warnings.push(`battle.json 的 "${key}" 应为非空数字数组，已忽略`);
                }
            } else if (typeof cur === 'number') {
                const n = num(v, NaN);
                if (Number.isFinite(n)) target[key] = n;
                else GameConfig._warnings.push(`battle.json 的 "${key}" 不是数字，已忽略`);
            } else if (typeof cur === 'boolean') {
                if (typeof v === 'boolean') target[key] = v;
                else GameConfig._warnings.push(`battle.json 的 "${key}" 应为 true / false，已忽略`);
            } else if (typeof cur === 'string') {
                if (typeof v === 'string') target[key] = v;
            }
        }

        if (BATTLE.firstDelayMax < BATTLE.firstDelayMin) {
            GameConfig._warnings.push('battle.json 的 firstDelayMax 小于 firstDelayMin，已对调');
            const t = BATTLE.firstDelayMax;
            (BATTLE as any).firstDelayMax = BATTLE.firstDelayMin;
            (BATTLE as any).firstDelayMin = t;
        }
    }

    /** 组装 CHARACTERS：character 提供主键，spine / anim / skill 按外键各补一块 */
    private static _build (battle: any, characterSheet: any, spineSheet: any, animSheet: any, skillSheet: any): void {
        const charRows: CharacterRow[] = rowsOf(characterSheet, 'character');
        const spineRows: SpineRow[] = rowsOf(spineSheet, 'spine');
        const animRows: AnimRow[] = rowsOf(animSheet, 'anim');
        const skillRows: SkillRow[] = rowsOf(skillSheet, 'skill');

        // ---- 索引 ----
        const spineMap = new Map<string, SpineRow>();
        for (const r of spineRows) {
            if (!r || !r.id) { GameConfig._warnings.push('spine.json 存在没有 id 的行，已跳过'); continue; }
            if (spineMap.has(r.id)) GameConfig._warnings.push(`spine.json 的 id "${r.id}" 重复，取第一行`);
            else spineMap.set(r.id, r);
        }

        const animMap = new Map<string, { idle?: AnimRow; run?: AnimRow; hurt?: AnimRow; attacks: AnimRow[] }>();
        animRows.forEach((r, i) => {
            if (!r || !r.charId) { GameConfig._warnings.push('anim.json 存在没有 charId 的行，已跳过'); return; }
            let g = animMap.get(r.charId);
            if (!g) { g = { attacks: [] }; animMap.set(r.charId, g); }
            const kind = r.kind;
            if (kind === 'idle') g.idle = r;
            else if (kind === 'run') g.run = r;
            else if (kind === 'hurt') g.hurt = r;
            else if (kind === 'attack') {
                // order 缺省时按行号，保证稳定
                if (typeof r.order !== 'number') (r as any).order = i;
                g.attacks.push(r);
            } else {
                GameConfig._warnings.push(`anim.json 第 ${i + 1} 行的 kind "${kind}" 无效（应为 idle/run/hurt/attack）`);
            }
        });
        for (const g of animMap.values()) {
            g.attacks.sort((a, b) => (a.order as number) - (b.order as number));
        }

        const skillMap = new Map<string, SkillRow[]>();
        skillRows.forEach((r, i) => {
            if (!r || !r.charId) { GameConfig._warnings.push('skill.json 存在没有 charId 的行，已跳过'); return; }
            const list = skillMap.get(r.charId) ?? [];
            // slot 缺省时按行号排在后面
            if (typeof r.slot !== 'number') (r as any).slot = list.length + 1;
            list.push(r);
            skillMap.set(r.charId, list);
        });
        for (const [id, list] of skillMap) {
            list.sort((a, b) => a.slot - b.slot);
            const seen = new Set<number>();
            for (const r of list) {
                if (seen.has(r.slot)) GameConfig._warnings.push(`skill.json 的 ${id} 第 ${r.slot} 槽重复，后者会被跳过`);
                seen.add(r.slot);
            }
        }

        // ---- 组装 ----
        const built: CharacterConfig[] = [];
        const usedIds = new Set<string>();

        for (const r of charRows) {
            if (!r || !r.id) { GameConfig._warnings.push('character.json 存在没有 id 的行，已跳过'); continue; }
            if (usedIds.has(r.id)) { GameConfig._warnings.push(`character.json 的 id "${r.id}" 重复，取第一行`); continue; }
            usedIds.add(r.id);

            const sp = spineMap.get(r.id);
            if (!sp) GameConfig._warnings.push(`角色 ${r.id} 缺少 spine.json 配置，使用默认显示参数（可能大小异常）`);

            let path = str(sp?.path, `${r.id}/${r.id}`);
            const bundle = str(sp?.bundle, DEFAULT_BUNDLE);
            if (path.startsWith(`${bundle}/`)) path = path.slice(bundle.length + 1);

            const g = animMap.get(r.id);
            if (!g || !g.idle) GameConfig._warnings.push(`角色 ${r.id} 缺少 idle 动画（anim.json），已用 stand 兜底`);
            if (!g || !g.run) GameConfig._warnings.push(`角色 ${r.id} 缺少 run 动画（anim.json），已用 idle 兜底`);
            if (!g || g.attacks.length === 0) GameConfig._warnings.push(`角色 ${r.id} 没有 attack 动画（anim.json），普攻将不可用`);

            const idle = g && g.idle ? g.idle : { anim: 'stand', duration: 2.5 };
            const run = g && g.run ? g.run : { anim: idle.anim, duration: idle.duration };
            const hurt = g && g.hurt ? g.hurt : { anim: '', duration: 0 };
            const attacks: AnimRef[] = (g ? g.attacks : [])
                .filter((a) => a.anim)
                .map((a) => ({ name: a.anim, duration: Math.max(0.05, num(a.duration, 1)) }));

            const skills = GameConfig._toSkills(skillMap.get(r.id) ?? [], r.id);
            if (skills.length === 0) GameConfig._warnings.push(`角色 ${r.id} 没有任何技能（skill.json），战斗中不会出现技能键`);

            const scale = num(sp?.scale, 1);

            built.push({
                id: r.id,
                name: str(r.name, r.id),
                bundlePath: path,
                idle: idle.anim,
                idleDuration: Math.max(0.05, num(idle.duration, 2.5)),
                run: run.anim,
                runDuration: Math.max(0.05, num(run.duration, 0.7)),
                attackPool: attacks,
                hurt: hurt.anim || '',
                hurtDuration: Math.max(0, num(hurt.duration, 0)),
                maxHp: Math.max(1, num(r.maxHp, 1000)),
                atk: Math.max(1, num(r.atk, 80)),
                def: Math.max(0, num(r.def, 10)),
                critRate: clamp(num(r.critRate, 0.1), 0, 1),
                attackRange: Math.max(40, num(r.attackRange, 400)),
                moveSpeed: Math.max(20, num(r.moveSpeed, 320)),
                accent: str(r.accent, '#7fd4ff'),
                // 配置里没写 id 的显示参数走兜底：scale 必须为正，否则角色会消失
                displayScale: scale > 0.01 ? scale : 1,
                anchorX: num(sp?.anchorX, 0),
                anchorY: num(sp?.anchorY, 0),
                headY: num(sp?.headY, 400),
                // flip 允许写 true/false 或 1/0
                flipX: sp?.flip === true || num(sp?.flip, 0) !== 0,
                offsetX: num(sp?.offsetX, 0),
                offsetY: num(sp?.offsetY, 0),
                skills,
            });
        }

        // ---- 反向检查：孤儿行 ----
        for (const id of spineMap.keys()) {
            if (!usedIds.has(id)) GameConfig._warnings.push(`spine.json 的 "${id}" 在 character.json 里不存在，已忽略`);
        }
        for (const id of animMap.keys()) {
            if (!usedIds.has(id)) GameConfig._warnings.push(`anim.json 的 charId "${id}" 在 character.json 里不存在，已忽略`);
        }
        for (const id of skillMap.keys()) {
            if (!usedIds.has(id)) GameConfig._warnings.push(`skill.json 的 charId "${id}" 在 character.json 里不存在，已忽略`);
        }

        // ---- 主题色 / 显示名重复提示 ----
        const nameSeen = new Map<string, string>();
        for (const c of built) {
            const dup = nameSeen.get(c.name);
            if (dup) GameConfig._warnings.push(`角色 "${c.name}" 重名（${dup} 与 ${c.id}），下拉列表里会分不清`);
            else nameSeen.set(c.name, c.id);
        }

        CHARACTERS.length = 0;
        CHARACTERS.push(...built);
    }

    /** skill.json 的若干行 → SkillDef[]（slot 连续，供按钮直接按下标取用） */
    private static _toSkills (rows: SkillRow[], charId: string): SkillDef[] {
        const out: SkillDef[] = [];
        for (const r of rows) {
            if (!r.anim) {
                GameConfig._warnings.push(`角色 ${charId} 的技能 "${r.name || r.slot}" 没有绑定 anim，已跳过`);
                continue;
            }
            const name = str(r.name, `技能${r.slot}`);
            const short = str(r.short, name.slice(0, 2));
            const hits = GameConfig._toHits(r, charId, name);

            // 按钮文案只需要知道「这是治疗技能还是伤害技能」
            const isHeal = hits.some((h) => h.effects.some((e) => {
                const def = BUFFS.get(e.buff);
                if (!def || def.target !== 'self') return false;
                // 方向看 sign，没填才退回 value 的正负号
                const v = GameConfig._refValue(e);
                const dir = def.sign !== 0 ? def.sign : Math.sign(v);
                return dir > 0;
            }));

            out.push({
                id: `skill${r.slot}`,
                name,
                short,
                animation: r.anim,
                duration: Math.max(0, num(r.duration, 0)),
                hits,
                energyCost: clamp(num(r.energyCost, 40), 0, 100),
                cooldown: Math.max(0, num(r.cooldown, 4)),
                lunge: num(r.lunge, 60),
                range: Math.max(0, num(r.range, 0)),
                color: str(r.color, '#ffffff'),
                type: isHeal ? 'heal' : 'damage',
            });
        }
        return out;
    }

    /** 一个 buff 引用最终生效的数值（hit 里没写就用 buff 表里的默认值） */
    private static _refValue (ref: BuffRef): number {
        if (Number.isFinite(ref.value)) return ref.value;
        return BUFFS.get(ref.buff)?.value ?? 0;
    }

    /**
     * skill.json 的 hits → HitPoint[]
     *
     * 兼容两种写法：
     *   0.45                                  → 旧格式，视为一段纯伤害
     *   { at, effects:[{buff,value,chance}] } → 新格式，用到的 buff 必须存在于 buff.json
     */
    private static _toHits (r: SkillRow, charId: string, skillName: string): HitPoint[] {
        const raw: Array<number | HitRow> = Array.isArray(r.hits) && r.hits.length > 0 ? r.hits : [0.45];
        const hits: HitPoint[] = [];

        for (const h of raw) {
            if (typeof h === 'number') {
                // 旧写法：一段纯伤害，倍率取自旧字段（没有就 1 倍）
                hits.push({
                    at: clamp(num(h, 0.45), 0.02, 0.98),
                    effects: [{
                        buff: 'dmg',
                        value: num((r as any).damageMul, NaN),
                        chance: 1,
                        stacks: 1,
                    }],
                    shake: 0,
                });
                continue;
            }

            const at = clamp(num(h?.at, 0.45), 0.02, 0.98);
            const effects: BuffRef[] = [];

            for (const e of (Array.isArray(h?.effects) ? h.effects : [])) {
                const id = str(e?.buff, '');
                if (!id) {
                    GameConfig._warnings.push(`技能 ${charId}·${skillName} 第 ${hits.length + 1} 段有 effects 缺 buff，已跳过`);
                    continue;
                }
                if (!BUFFS.has(id)) {
                    GameConfig._warnings.push(
                        `技能 ${charId}·${skillName} 第 ${hits.length + 1} 段引用了不存在的 buff "${id}"，已跳过`,
                    );
                    continue;
                }
                effects.push({
                    buff: id,
                    value: typeof e.value === 'number' ? e.value : NaN,
                    chance: clamp(num(e.chance, 1), 0, 1),
                    stacks: Math.max(1, Math.floor(num(e.stacks, 1))),
                });
            }

            if (effects.length === 0) {
                GameConfig._warnings.push(`技能 ${charId}·${skillName} 第 ${hits.length + 1} 段没有任何有效效果`);
            }
            hits.push({ at, effects, shake: Math.max(0, num(h?.shake, 0)) });
        }

        hits.sort((a, b) => a.at - b.at);
        return hits;
    }

    private static _countSkills (): number {
        return CHARACTERS.reduce((n, c) => n + c.skills.length, 0);
    }
}
