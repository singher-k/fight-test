#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配置表结构 —— 唯一来源。

gen-templates.py（JSON → xlsx + ConfigTypes.ts）与 export-config.py（xlsx → JSON）
都从这里读列定义。改列只改这一个文件，两个方向不会再漂移。

------------------------------------------------------------------
字段格式（行式表）
------------------------------------------------------------------
    (字段名, 数据类型, 短备注, 是否必填)               ← 常用
    (字段名, 数据类型, 短备注, 是否必填, 详细说明)     ← 需要多解释时
    (字段名, 数据类型, 短备注, 是否必填, 详细说明, EMPTY_OK)  ← 空串有业务含义时

  短备注  几个字，只说明「这个字段是什么」。
          同时用于：xlsx 数据页第 1 行、ConfigTypes.ts 的 /** */ 注释。
          ★ 规则、取值范围、坑，一律写到 xlsx 的「配置规则」页，不写这里。
  详细说明 可选。写进规则页「列说明」表格，只有需要展开时才填。

------------------------------------------------------------------
数值类型：只允许 int，不允许小数
------------------------------------------------------------------
  int    整数。血量 / 射程 / 距离 / 层数 这类本身就是整数的量。
  wf     万分比整数。凡是「本质是比例或倍数」的都用它：填 13500 表示 1.35。
         ★ 运行时不靠猜：GameConfig 里对应字段显式用 wf() 读，读入即 /10000。
         xlsx 数据类型列仍显示 int（存的确实是整数），短备注带「(万分比)」。
  ms     毫秒整数。凡是「时间」都用它：填 1700 表示 1.7 秒。
         ★ 运行时不靠猜：GameConfig 里对应字段显式用 ms() 读，读入即 /1000。
         xlsx 数据类型列仍显示 int，短备注带「(毫秒)」。
         ★ 时间不要用 wf：17000 到底是 1.7 秒还是 17000 毫秒，读的人分不清，
           已经踩过一次（hit.at 被填成毫秒值、却按万分比解析）。

  其它类型
    string                → string
    bool / boolean        → boolean
    【其它内容原样透传为 TS 类型表达式】
    所以想写精确类型时直接写：-1 | 0 | 1、'self' | 'enemy'、
    { atk?: number }、AnimKind ……

  是否必填  True → 生成 `name: T`；False → 生成 `name?: T`
            与 export-config.py 的必填校验共用同一个标记，不会两处打架。

------------------------------------------------------------------
字段格式（键值表 KV_TABLES）
------------------------------------------------------------------
    (键名, 数据类型, 短备注, 详细说明)
  battle.json 是扁平对象（没有 rows），每种键是一行，导出时再组装回对象。
  ★ 键值表的 wf 键必须同步登记到 GameConfig.ts 的 BATTLE_WF_KEYS，
    ms 键必须登记到 BATTLE_MS_KEYS，一致性由 gen-templates.py 的自检把关。
"""

# ---------------------------------------------------------------------
# 类型别名（生成的 ConfigTypes.ts 里排在各 Row 之前）
# ---------------------------------------------------------------------
TYPE_ALIASES = [
    ('AnimKind', "'idle' | 'run' | 'hurt' | 'attack'", 'anim.json 的动画类别'),
]


#: 字段元组第 6 位标记：单元格留空也视为「填了空字符串」，而不是漏填。
#: 只给那些「空串本身有业务含义」的列用（如 anim 的 anim 空 = 该角色没有这个动作）。
EMPTY_OK = True


#: 万分比类型标记。
#: 配置里存整数（13500），运行时 GameConfig 里用 wf() 读，读入即 /10000 → 1.35。
#: 加了这个标记的字段：导出时必须是整数、填小数会被拦、TS 类型仍是 number。
#: ★ 只给「比例 / 倍数」用（伤害倍率、暴击率、概率、缩放、属性百分比）。
WF = 'wf'

#: 毫秒类型标记。
#: 配置里存整数毫秒（1700），运行时 GameConfig 里用 ms() 读，读入即 /1000 → 1.7 秒。
#: ★ 所有「时间」字段都用它（duration / cooldown / tick / at …）。
#:   时间写成万分比会让人分不清 17000 是 1.7 秒还是 17000 毫秒。
MS = 'ms'

#: 对象列内部每个值也是万分比的字段（对象类型语法表达不了元素语义，单独登记）。
#: buff.stats = { "atk": 3000, "moveSpeed": -4000 } —— 键都是万分比。
OBJ_WF_KEYS = {
    'buff': {'stats': ('atk', 'def', 'moveSpeed', 'critRate')},
}


# ---------------------------------------------------------------------
# 行式表：一行 = 一条记录，JSON 里是 {"rows": [...]}
# ---------------------------------------------------------------------
TABLES = {
    'character': {
        'sheet': '角色',
        'cls': 'CharacterRow',
        'doc': 'character.json 的一行：角色的战斗数值',
        'cols': [
            ('id', 'string', '角色id', True,
             '主键。spine.json 用同一个 id；anim / skill / hit 里叫 charId'),
            ('name', 'string', '显示名', True),
            ('maxHp', 'int', '最大生命', True),
            ('atk', 'int', '攻击力', True),
            ('def', 'int', '防御力', True),
            ('critRate', WF, '暴击率(万分比)', True,
             '万分比：1000 = 10%。GameConfig 读入时自动 /10000'),
            ('attackRange', 'int', '普攻射程', True,
             '两人中心距，720×1280 基准像素'),
            ('moveSpeed', 'int', '移动速度', True,
             'px/s，720×1280 基准像素'),
            ('accent', 'string', '主题色', True,
             '#rrggbb，用于血条 / 名字 / 选中态'),
        ],
    },

    'spine': {
        'sheet': '资源',
        'cls': 'SpineRow',
        'doc': 'spine.json 的一行：角色的资源与显示参数',
        'cols': [
            ('id', 'string', '角色id', True, '外键：character.json 的 id'),
            ('bundle', 'string', '资源包', False, "Asset Bundle 名，缺省 'spine'"),
            ('path', 'string', '资源路径', True, 'Bundle 内路径，不含扩展名'),
            ('scale', WF, '基准缩放(万分比)', True,
             '万分比：3160 = 0.316。把各角色统一到同一体高'),
            ('anchorX', 'int', '锚点X', True, '骨架坐标系里的对齐参考点 X'),
            ('anchorY', 'int', '锚点Y', True, '骨架坐标系里的对齐参考点 Y（脚底）'),
            ('headY', 'int', '头顶Y', True,
             '头顶在骨架坐标系里的 Y，用于定位血条与飘字'),
            ('flip', 'boolean | number', '水平翻转', False,
             '资源自身朝向与「标准朝右」相反时填 true（也可写 1/0），'
             '渲染时整体镜像'),
            ('offsetX', 'int', '微调X', False, '像素级微调，不受 flip 影响'),
            ('offsetY', 'int', '微调Y', False, '像素级微调，不受 flip 影响'),
        ],
    },

    'anim': {
        'sheet': '动画',
        'cls': 'AnimRow',
        'doc': 'anim.json 的一行：一个动画引用',
        'cols': [
            ('charId', 'string', '角色id', True, '外键：character.json 的 id'),
            ('kind', 'AnimKind', '动画类别', True,
             'idle 待机 / run 移动 / hurt 受击 / attack 普攻'),
            ('anim', 'string', '动画名', True,
             'Spine 动画名；空字符串表示该角色没有这个动作', EMPTY_OK),
            ('duration', MS, '原始时长(毫秒)', True,
             '毫秒：1500 = 1.5 秒。骨架内原始时长，用于算播放倍速'),
            ('order', 'int', '轮换顺序', False,
             '仅 attack 有意义：普攻动作池的轮换顺序，升序；缺省按行号'),
        ],
    },

    'buff': {
        'sheet': 'buff',
        'cls': 'BuffRow',
        'doc': 'buff.json 的一行：一个 buff 的定义',
        'cols': [
            ('id', 'string', 'buffid', True, '主键，hit.json 的 e1..e4 效果格里按它引用'),
            ('name', 'string', '显示名', True, '飘字与日志用'),
            ('buffType', 'string', '分类', True, 'BUFFTYPE 的键名，仅做标签，不参与行为分发'),
            ('target', "'self' | 'enemy'", '施加对象', False, '缺省 enemy'),
            ('duration', MS, '持续时长(毫秒)', False,
             '毫秒：1500 = 1.5 秒。0 / 缺省 = 瞬时'),
            ('tick', MS, '结算间隔(毫秒)', False,
             '毫秒：500 = 0.5 秒。与 duration 配合出 dot / hot'),
            ('value', WF, '数值(万分比)', False,
             '万分比：16000 = 1.6 倍攻击。只写绝对值，方向由 sign 决定'),
            ('valueType', "'atkMul' | 'atkFlat' | 'maxHpRatio' | 'flat'", '数值口径', False,
             '攻击力百分比 / 固定攻击力 / 目标最大生命百分比 / 固定数值'),
            ('sign', '-1 | 0 | 1', '结算方向', False,
             '-1 伤害 / 1 治疗；0 或缺省时退回按 value 的正负号'),
            ('stats',
             '{ atk?: number; def?: number; moveSpeed?: number; critRate?: number }',
             '属性增减(万分比)', False,
             '每项都是万分比：{ "atk": 3000, "moveSpeed": -4000 } = 攻击 +30%、移速 -40%'),
            ('control', "'stun' | 'root' | 'silence'", '控制类型', False,
             '眩晕 / 定身 / 沉默'),
            ('distance', 'int', '击退距离', False, '世界单位（整数像素，不是万分比）'),
            ('height', 'int', '击飞高度', False, '世界单位，> 0 走抛物线'),
            ('moveTime', MS, '位移耗时(毫秒)', False,
             '毫秒：350 = 0.35 秒'),
            ('stackMax', 'int', '最大层数', False, '缺省 1'),
            ('stackMode', "'refresh' | 'stack' | 'ignore'", '叠加规则', False, '缺省 refresh'),
            ('color', 'string', '配色', False, '飘字与日志配色 #rrggbb'),
            ('shake', WF, '震屏强度(万分比)', False,
             '万分比：6000 = 6。命中震屏'),
        ],
    },

    'skill': {
        'sheet': '技能',
        'cls': 'SkillRow',
        'doc': 'skill.json 的一行：一个技能',
        'cols': [
            ('charId', 'string', '角色id', True, '必须在 character.json 里存在'),
            ('slot', 'int', '技能槽位', True,
             '1~4，同一角色内不能重复。按钮顺序由本表行顺序决定，不是这个数值'),
            ('name', 'string', '技能名', False, '显示在按钮与日志；缺省用「技能N」'),
            ('short', 'string', '按钮短名', False, '缺省取 name 前 2 字'),
            ('anim', 'string', '动画名', True, '留空则整行被跳过，技能不会出现'),
            ('duration', MS, '演出时长(毫秒)', False,
             '毫秒：1500 = 1.5 秒。决定播放倍速；0 / 缺省按动画原速'),
            ('energyCost', 'int', '能量消耗', False, '0~100'),
            ('cooldown', MS, '冷却时长(毫秒)', False,
             '毫秒：2500 = 2.5 秒。从动作播完开始计时（不是按下按钮开始）'),
            ('lunge', 'int', '前冲距离', False, '当前运行时不生效，字段保留备用'),
            ('range', 'int', '射程', False, '720 基准；0 / 缺省沿用角色的 attackRange'),
            ('color', 'string', '主题色', False, '#rrggbb'),
        ],
    },

    'hit': {
        'sheet': '打击点',
        'cls': 'HitRow',
        'doc': 'hit.json 的一行：一个打击点',
        'cols': [
            ('charId', 'string', '角色id', True, '外键：character.json 的 id'),
            ('slot', 'int', '技能槽位', True, '外键：skill.json 同角色的 slot'),
            ('hit', 'int', '段序号', False,
             '1 起，缺省按行序自动编号。同一 charId + slot 下不能重复'),
            ('at', MS, '打击时刻(毫秒)', True,
             '毫秒：距技能动画开始的时刻，765 = 0.765 秒。'
             '上限是该技能的演出时长（skill.duration；填 0 时按 battle.skillTargetTime），'
             '超出会被钳到动画末尾'),
            ('shake', WF, '震屏强度(万分比)', False,
             '万分比：6000 = 6。这一段命中的震屏，0 / 缺省 = 不震'),
            ('e1', 'string', '效果1', False,
             '语法 <buffId>[:value][@chance][#stacks]，value 与 chance 用万分比，'
             '如 dmg:16000、slow@4000'),
            ('e2', 'string', '效果2', False, '必须紧接 e1 填，中间不能空'),
            ('e3', 'string', '效果3', False),
            ('e4', 'string', '效果4', False, '一段最多 4 组，e5 及以后不存在'),
        ],
    },
}


# ---------------------------------------------------------------------
# 键值表：JSON 是扁平对象，每种键一行
# ---------------------------------------------------------------------
KV_TABLES = {
    'battle': {
        'sheet': '全局参数',
        'doc': 'battle.json：全局战斗参数（扁平对象，不是 rows）',
        'keys': [
            ('defaultHeroId', 'string', '默认我方', '开战时默认上场的角色 id'),
            ('defaultEnemyId', 'string', '默认敌方', '开战时默认对手的角色 id'),
            ('characterScale', WF, '角色缩放(万分比)', '万分比：5000 = 0.5。Spine 整体缩放'),
            ('groundOffsetY', 'int', '地面偏移', '地面线相对屏幕中心的 Y 偏移（整数像素）'),
            ('worldWidthScreens', WF, '战场宽度(万分比)', '万分比：24000 = 2.4 屏'),
            ('spawnDistance', 'int', '初始间距', '双方开场时的中心距（整数像素）'),
            ('aggroRatio', WF, '索敌距离比(万分比)', '万分比：8000 = 0.8。进入追击的距离 = 射程 × 系数'),
            ('camDeadZone', 'int', '镜头死区', '角色在中央该范围内移动时镜头不跟随（整数像素）'),
            ('approachTime', MS, '接敌耗时(毫秒)', '毫秒：2500 = 2.5 秒'),
            ('loopNextDelay', MS, '下一轮间隔(毫秒)', '毫秒：1000 = 1 秒。一轮打完到下一轮开始的间隔'),
            ('loopHealRatio', 'int', '轮回复活比例', '新一轮开始时回血的比例，1 = 回满'),
            ('loopRoamDistance', 'int', '巡逻距离', '无目标时的来回走动距离（整数像素）'),
            ('headBarWidth', 'int', '血条宽度', '头顶血条的宽度（整数像素）'),
            ('headBarOffsetY', 'int', '血条高度', '血条相对头顶的 Y 偏移（整数像素）'),
            ('attackInterval', MS, '普攻间隔(毫秒)', '毫秒：150 = 0.15 秒'),
            ('attackTargetTime', MS, '普攻时长(毫秒)', '毫秒：650 = 0.65 秒'),
            ('skillTargetTime', MS, '技能时长(毫秒)', '毫秒：1450 = 1.45 秒'),
            ('hurtLockTime', MS, '受击硬直(毫秒)', '毫秒：320 = 0.32 秒'),
            ('skillSuperArmor', 'bool', '技能霸体', 'true = 技能演出期间不被受击打断'),
            ('hitProgress', WF, '普攻打击点(万分比)', '万分比：4500 = 0.45，普攻的动作进度'),
            ('energyPerAttack', 'int', '攻击回能', '每次普攻命中回的能量'),
            ('energyPerHurt', 'int', '受击回能', '每次受击回的能量'),
            ('energyMax', 'int', '能量上限', '满能量才能放技能'),
            ('critMul', WF, '暴击倍率(万分比)', '万分比：17500 = 1.75'),
            ('defenseFactor', WF, '防御系数(万分比)', '万分比：5000 = 0.5，减伤公式里的防御权重'),
            ('attackShake', 'int', '普攻震屏', '普攻命中的震屏强度，0 = 不震（整数像素）'),
            ('attackCritShake', 'int', '暴击震屏', '暴击时的震屏强度（整数像素）'),
            ('speedOptions', 'list', '倍速选项(万分比)',
             '逗号分隔的万分比：5000,10000,20000,30000 = 0.5,1,2,3 倍速'),
            ('firstDelayMin', MS, '首击延迟下限(毫秒)', '毫秒：350 = 0.35 秒'),
            ('firstDelayMax', MS, '首击延迟上限(毫秒)', '毫秒：1000 = 1 秒。开场第一次出手的最长延迟'),
        ],
    },
}


# ---------------------------------------------------------------------
# 派生信息
# ---------------------------------------------------------------------
#: 数据类型 → TS 类型；不在表里的原样透传（允许直接写联合类型 / 嵌套对象）
TS_TYPE_MAP = {
    'int': 'number',
    WF: 'number',          # 万分比存整数，还原后仍是 number
    MS: 'number',          # 毫秒存整数，还原后是 number（秒）
    'number': 'number',
    'string': 'string',
    'str': 'string',
    'text': 'string',
    'bool': 'boolean',
    'boolean': 'boolean',
    # 键值表可能出现的数组（battle.speedOptions）
    'list': 'number[]',
    'array': 'number[]',
}

#: 历史遗留：float / double 不再允许出现在 schema 里，出现即视为错误。
FORBIDDEN_TYPES = {'float', 'double', 'real'}


def ts_type(raw):
    """数据类型列 → TS 类型。未收录的原样返回，支持手写 TS 表达式。"""
    return TS_TYPE_MAP.get(str(raw).strip(), str(raw).strip())


def is_wf(raw):
    return str(raw).strip().lower() == WF


def is_ms(raw):
    return str(raw).strip().lower() == MS


def is_numeric_type(raw):
    """这一列导出时是否该当数字处理。

    覆盖两种情况：
      int / wf / number     → 走 TS_TYPE_MAP
      '-1 | 0 | 1'          → 纯数字字面量的联合类型（如 sign），值域限死但仍存数字
    """
    s = str(raw).strip()
    if ts_type(s) == 'number':
        return True
    if '|' in s:
        parts = [p.strip() for p in s.split('|')]
        return bool(parts) and all(
            p.lstrip('+-').replace('.', '', 1).isdigit() for p in parts)
    return False


def is_bool_type(raw):
    """bool / boolean / boolean | number 都算布尔列。"""
    return 'bool' in str(raw).strip().lower()


# ---- 字段元组的兼容取值 ----
def col_name(c):
    return c[0]


def col_type(c):
    return c[1]


def col_remark(c):
    """短备注：xlsx 数据页第 1 行 + TS 注释首行。"""
    return c[2]


def col_required(c):
    return c[3]


def col_long(c):
    """详细说明（可选）：规则页「列说明」表格用。"""
    return c[4] if len(c) > 4 else ''


def col_allow_empty(c):
    """第 6 位标记：单元格留空也视为「填了空字符串」，而不是漏填。"""
    return len(c) > 5 and c[5] is EMPTY_OK


def col_doc(c):
    """ConfigTypes.ts 的 JSDoc 正文（多行时由调用方补 * 前缀）。"""
    long = col_long(c)
    return f'{col_remark(c)}\n * {long}' if long else col_remark(c)


def xlsx_type(raw):
    """xlsx「数据类型」列显示什么。

    万分比 / 毫秒存的确实都是整数，所以都显示 int；这层语义由短备注承担
    （「(万分比)」/「(毫秒)」），详细换算规则在规则页。
    这样类型列保持用户要求的简洁（string / int / 数组）。
    """
    return 'int' if (is_wf(raw) or is_ms(raw)) else str(raw)


def doc_type(raw):
    """规则页「类型」列：万分比 / 毫秒必须明确标出来，否则会被当成普通整数。"""
    if is_wf(raw):
        return 'int(万分比)'
    if is_ms(raw):
        return 'int(毫秒)'
    return str(raw)


# ---- 行式表 ----
def col_names(table):
    """该表的字段名列表（顺序与 xlsx 列顺序一致）。"""
    return [col_name(c) for c in TABLES[table]['cols']]


def row_tables():
    """所有行式表，按字典顺序输出（即 ConfigTypes.ts 里 interface 的顺序）。"""
    return list(TABLES.keys())


def xlsx_tables():
    """需要生成 xlsx 配表模板的行式表。"""
    return [t for t, spec in TABLES.items() if spec.get('xlsx', True)]


def required(table):
    """该表的必填字段集合，供 export-config.py 做校验。"""
    return {col_name(c) for c in TABLES[table]['cols'] if col_required(c)}


def numeric_cols(table):
    """该表需要转成数字的列（含 -1 | 0 | 1 这种纯数字联合类型）。"""
    return {col_name(c) for c in TABLES[table]['cols'] if is_numeric_type(col_type(c))}


def int_cols(table):
    """需要取整的列：int 以及 wf / ms（存的都是整数）。"""
    return {col_name(c) for c in TABLES[table]['cols']
            if str(col_type(c)).strip().lower() == 'int'
            or is_wf(col_type(c)) or is_ms(col_type(c))}


def wf_cols(table):
    """万分比列：导出必须是整数，运行时由 GameConfig 的 wf() 还原。"""
    return {col_name(c) for c in TABLES[table]['cols'] if is_wf(col_type(c))}


def ms_cols(table):
    """毫秒列：导出必须是整数，运行时由 GameConfig 的 ms() 还原成秒。"""
    return {col_name(c) for c in TABLES[table]['cols'] if is_ms(col_type(c))}


def bool_cols(table):
    """该表的布尔列（类型里出现 boolean，如 bool / boolean | number）。"""
    return {col_name(c) for c in TABLES[table]['cols'] if is_bool_type(col_type(c))}


def empty_ok_cols(table):
    """留空也算有效值的列（空串有业务含义）。"""
    return {col_name(c) for c in TABLES[table]['cols'] if col_allow_empty(c)}


def json_cols(table):
    """类型写成对象字面量的列（如 stats 的 { atk?: number }）。

    Excel 存不了对象，所以单元格里放 JSON 文本，导出时再 parse 回对象。
    """
    return {col_name(c) for c in TABLES[table]['cols']
            if str(col_type(c)).strip().startswith('{')}


# ---- 键值表 ----
def kv_tables():
    return list(KV_TABLES.keys())


def kv_names(table):
    return [k[0] for k in KV_TABLES[table]['keys']]


def kv_numeric(table):
    """需要转成数字的键。"""
    return {k[0] for k in KV_TABLES[table]['keys'] if is_numeric_type(k[1])}


def kv_ints(table):
    """需要取整的键：int / wf / ms。"""
    return {k[0] for k in KV_TABLES[table]['keys']
            if str(k[1]).strip().lower() == 'int'
            or is_wf(k[1]) or is_ms(k[1])}


def kv_wf(table):
    """万分比键：必须与 GameConfig.ts 的 BATTLE_WF_KEYS 完全一致。"""
    return {k[0] for k in KV_TABLES[table]['keys'] if is_wf(k[1])}


def kv_ms(table):
    """毫秒键：必须与 GameConfig.ts 的 BATTLE_MS_KEYS 完全一致。"""
    return {k[0] for k in KV_TABLES[table]['keys'] if is_ms(k[1])}


def kv_lists(table):
    """数组类型的键（Excel 里写 "5000,10000,20000,30000"）。"""
    return {k[0] for k in KV_TABLES[table]['keys'] if str(k[1]).strip().lower() in ('list', 'array')}


def kv_list_wf(table):
    """数组的每一项是否也是万分比。

    靠短备注里的「万分比」标记判断（list 类型名本身表达不了元素语义），
    目前只有 battle.speedOptions 是这样。
    """
    return {k[0] for k in KV_TABLES[table]['keys']
            if str(k[1]).strip().lower() in ('list', 'array')
            and '万分比' in str(k[2])}


def all_ms_fields():
    """全项目毫秒字段清单：(table, field) 集合，供一致性门禁使用。

    与 all_wf_fields() 同构，只是换成毫秒列。
    """
    out = set()
    for t in TABLES:
        for c in TABLES[t]['cols']:
            if is_ms(col_type(c)):
                out.add((t, col_name(c)))
    for t in KV_TABLES:
        for k in KV_TABLES[t]['keys']:
            if is_ms(k[1]):
                out.add((t, k[0]))
    return out


def all_wf_fields():
    """全项目万分比字段清单：(table, field) 集合，供一致性门禁使用。

    包含三类：
      1. 行式表里类型标成 wf 的列
      2. 键值表里类型标成 wf 的键
      3. 对象列内部的万分比键（buff.stats.atk 等），以及备注带「万分比」的数组
    """
    out = set()
    for t in TABLES:
        for c in TABLES[t]['cols']:
            if is_wf(col_type(c)):
                out.add((t, col_name(c)))
        for f, keys in OBJ_WF_KEYS.get(t, {}).items():
            for k in keys:
                out.add((t, k))
    for t in KV_TABLES:
        for k in KV_TABLES[t]['keys']:
            if is_wf(k[1]):
                out.add((t, k[0]))
        for name in kv_list_wf(t):
            out.add((t, name))
    return out


def forbidden_type_fields():
    """schema 里还残留 float / double 的字段（应为空）。"""
    bad = []
    for t in TABLES:
        for c in TABLES[t]['cols']:
            if str(col_type(c)).strip().lower() in FORBIDDEN_TYPES:
                bad.append(f'{t}.{col_name(c)}')
    for t in KV_TABLES:
        for k in KV_TABLES[t]['keys']:
            if str(k[1]).strip().lower() in FORBIDDEN_TYPES:
                bad.append(f'{t}.{k[0]}')
    return bad
