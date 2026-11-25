#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xlsx → JSON 配置导出。

★ 配置流程：xlsx 是编辑入口，本脚本负责把它变成 JSON。
    config-templates/*.xlsx  →  [双击 导出配置.bat]  →  config-templates/json/*.json
                                                            ↓ [双击 tools/导入客户端.bat]
                                                    assets/resources/config/*.json  →  重启预览
    导出与导入分开，是为了让你先看一眼 json/ 里的产物对不对，再决定推给客户端。

用法（推荐双击 config-templates/导出配置.bat）：
    python config-templates/export-config.py                  # 预览：只算差异，不写盘
    python config-templates/export-config.py --write           # 真正写入 json/
    python config-templates/export-config.py --only hit        # 只导打击点
    python config-templates/export-config.py --only hit --write

安全策略：
    - 默认 dry-run。不写盘，只打印「新增 / 删除 / 修改」的条数与逐格样例。
    - --write 时先把旧 JSON 备份到 config-templates/.backup/。
    - 有任何【错误】直接中止，一个字节都不写：
        必填缺失、类型不是数字、主键重复、引用了不存在的角色 / buff / 技能、
        孤儿打击点、无法识别的效果格语法。
    - 【告警】不阻止写入，但会逐条列出（at 超过技能时长、效果格不连续、槽位超出 1~4 等）。

表头约定：
    行式表  第 1 行备注 / 第 2 行字段名 / 第 3 行数据类型 / 第 4 行起数据
    键值表  第 1 行「键名 / 类型 / 说明 / 值」/ 第 2 行起每种参数一行
导出只认行式表第 2 行的字段名；备注与类型行纯属给人看和给生成器读，改它们不影响导出。

列定义来自 config-templates/schema.py，与 gen-templates.py 共用同一份，不会漂移。
JSON 里只写配置数据，不带 _table / _version / _comment 这类元数据。
"""

import argparse
import io
import json
import os
import shutil
import sys
import time
from collections import OrderedDict

try:
    from openpyxl import load_workbook
except ImportError:
    load_workbook = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema  # noqa: E402  列定义唯一来源

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL_DIR = os.path.join(ROOT, 'config-templates')
# 导出产物落在 config-templates/json/，是「待验收」的中间层；
# assets/resources/config/ 只由 tools/import-config.py 写入，本脚本不碰。
JSON_DIR = os.path.join(TPL_DIR, 'json')
CLIENT_DIR = os.path.join(ROOT, 'assets', 'resources', 'config')

# 行式表的三行表头
HEADER_NAME_ROW = 2   # 字段名在这一行
HEADER_REMARK_ROW = 1  # 短备注在这一行
DATA_START_ROW = 4    # 数据从这一行开始

KV_HEAD = ['键名', '类型', '说明', '值']

# 解析顺序 = 依赖顺序：先有 character，才能校验 spine/anim/skill 的外键；
# 先有 skill，才能校验 hit 挂靠的技能；先有 buff，才能校验效果格。
ORDER = ['character', 'buff', 'spine', 'anim', 'skill', 'hit', 'battle']

ANIM_KINDS = {'idle', 'run', 'hurt', 'attack'}
MAX_HIT_EFFECTS = 4

# 行式表的字段级信息，全部从 schema 派生
TABLES = {}
for _t in schema.xlsx_tables():
    _spec = schema.TABLES[_t]
    _ints = schema.int_cols(_t)
    TABLES[_t] = {
        'sheet': _spec['sheet'],
        'cols': schema.col_names(_t),
        'ints': _ints - schema.wf_cols(_t) - schema.ms_cols(_t),   # 纯整数列（wf / ms 列单独校验）
        'wf': schema.wf_cols(_t),             # 万分比列：必须是整数，填小数报错
        'ms': schema.ms_cols(_t),             # 毫秒列：必须是整数，填小数报错
        'floats': schema.numeric_cols(_t) - _ints,
        'bools': schema.bool_cols(_t),        # bool / boolean | number
        'json': schema.json_cols(_t),         # 对象列：格子里是 JSON 文本
        'obj_wf': schema.OBJ_WF_KEYS.get(_t, {}),  # 对象列内部哪些键是万分比
        'empty_ok': schema.empty_ok_cols(_t), # 留空 = 空字符串（不是漏填）
        'required': schema.required(_t),
    }
del _t, _spec, _ints

KV = {}
for _t in schema.kv_tables():
    _spec = schema.KV_TABLES[_t]
    KV[_t] = {
        'sheet': _spec['sheet'],
        'names': schema.kv_names(_t),
        'ints': schema.kv_ints(_t) - schema.kv_wf(_t) - schema.kv_ms(_t),
        'wf': schema.kv_wf(_t),
        'ms': schema.kv_ms(_t),
        'floats': schema.kv_numeric(_t) - schema.kv_ints(_t),
        'lists': schema.kv_lists(_t),
        'list_wf': schema.kv_list_wf(_t),     # 数组里每项都是万分比
        'types': {k[0]: k[1] for k in _spec['keys']},
    }
del _t, _spec


def wf_int(v):
    """整数字段（万分比 / 毫秒）单元格 → (整数, None)；填了小数时返回 (None, 原值) 供调用方报错。"""
    n = to_number(v)
    if n is None:
        return None, None
    if isinstance(n, float) and not n.is_integer():
        return None, n
    return int(n), None


# ---------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------
def blank(v):
    return v is None or (isinstance(v, str) and v.strip() == '')


def display_path(p):
    """跨盘符时 relpath 会抛 ValueError，兜底成绝对路径。"""
    try:
        rel = os.path.relpath(p, ROOT)
    except ValueError:
        return p
    return p if rel.startswith('..') else rel


def to_number(v, as_int=False):
    """Excel 单元格 → 数字；无法转换返回 None。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        n = float(v)
    else:
        s = str(v).strip()
        if not s:
            return None
        try:
            n = float(s)
        except ValueError:
            return None
    if as_int:
        return int(round(n))
    return int(n) if float(n).is_integer() else n


def to_bool(v):
    """Excel 单元格 → 布尔；无法识别返回 None。"""
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ('true', '1', 'yes', 'y', '是', '真'):
        return True
    if s in ('false', '0', 'no', 'n', '否', '假'):
        return False
    return None


def to_list(v):
    """'5000,10000,20000,30000' → [5000, 10000, 20000, 30000]；无法解析返回 None。"""
    if isinstance(v, (list, tuple)):
        return [x for x in v if not blank(x)]
    parts = [p.strip() for p in str(v).replace('，', ',').split(',')]
    out = []
    for p in parts:
        if not p:
            continue
        n = to_number(p)
        if n is None:
            return None
        out.append(n)
    return out or None


_SEED_NOTICE = set()


def load_json(name):
    """读「上一版」JSON 作为差异基线。

    正常从 config-templates/json/ 读。json/ 里还没有这张表时（首次改造、
    或有人清空了目录），回退到客户端侧的 assets/resources/config/ —— 否则
    差异会显示成「整表新增」，外键校验也会因为拿不到旧 id 而集体报错。
    """
    p = os.path.join(JSON_DIR, f'{name}.json')
    if not os.path.exists(p):
        fallback = os.path.join(CLIENT_DIR, f'{name}.json')
        if os.path.exists(fallback) and name not in _SEED_NOTICE:
            _SEED_NOTICE.add(name)
            print(f'· {name}.json 在 config-templates/json/ 里还没有，'
                  f'暂以客户端现有 JSON 为基线')
            p = fallback
        else:
            return None
    with io.open(p, encoding='utf-8') as f:
        return json.load(f)


def pick_sheet(wb, wanted, fname):
    """取数据页：优先按名字，被改名时退化到第一个不含「规则」的页。"""
    if wanted in wb.sheetnames:
        return wb[wanted]
    for n in wb.sheetnames:
        if '规则' not in n:
            return wb[n]
    raise RuntimeError(f'{os.path.basename(fname)} 里找不到数据页（现有：{wb.sheetnames}）')


def read_sheet_xlsx(path, table):
    """读行式表的数据页。

    会拿第 2 行与 schema 里的列名逐一比对。这一步不是洁癖：老格式的表只有
    一行表头，如果放进这套解析，第 2 行会被当成字段名（实际是数据）、数据被
    吃掉两行、字段全部错位——而导出的 JSON 看起来「成功」了。宁可报错。
    """
    if load_workbook is None:
        raise RuntimeError('需要 openpyxl：pip install openpyxl')
    spec = TABLES[table]
    wb = load_workbook(path, data_only=True)
    ws = pick_sheet(wb, spec['sheet'], path)
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < DATA_START_ROW - 1:
        raise RuntimeError(
            f'{os.path.basename(path)} 只有 {len(rows)} 行，'
            f'表头需要 3 行（备注 / 字段名 / 数据类型）')

    header = [str(c).strip() if c is not None else '' for c in rows[HEADER_NAME_ROW - 1]]
    while header and header[-1] == '':   # Excel 偶尔带出尾部空列
        header.pop()
    if header != spec['cols']:
        raise RuntimeError(
            f'{os.path.basename(path)} 第 2 行的表头与 schema 不一致：\n'
            f'    期望 {spec["cols"]}\n'
            f'    实际 {header}\n'
            f'  常见原因：① 手上的 xlsx 是老格式（只有一行表头）→ 重跑 gen-templates.py --force；'
            f'② 增删了列 → 先改 schema.py，再重跑 gen-templates.py --force')

    out = []
    for r in rows[DATA_START_ROW - 1:]:
        out.append({header[i]: (r[i] if i < len(r) else '') for i in range(len(header))})

    # 单位守卫：字段名对得上不代表语义对得上。把「万分比 → 毫秒」这类单位迁移
    # 漏在一张表上，数值会整体差 10 倍，导出却「成功」。用第 1 行备注里的
    # 「万分比」/「毫秒」关键字核对，对不上就拦死。
    _check_unit_remarks(table, path, rows)
    return out


def _check_unit_remarks(table, path, rows):
    """第 1 行备注必须写明单位（万分比 / 毫秒），否则视为模板过期。"""
    cols = schema.TABLES[table]['cols']
    remark = rows[HEADER_REMARK_ROW - 1] if len(rows) >= HEADER_REMARK_ROW else ()
    bad = []
    for i, col in enumerate(cols):
        ct = schema.col_type(col)
        if schema.is_ms(ct):
            need = '毫秒'
        elif schema.is_wf(ct):
            need = '万分比'
        else:
            continue
        got = str(remark[i]).strip() if i < len(remark) and remark[i] is not None else ''
        if need not in got:
            bad.append(f'{schema.col_name(col)}（备注应含「{need}」，实际「{got}」）')
    if bad:
        raise RuntimeError(
            f'{os.path.basename(path)} 的模板是旧单位，导出会整体差 10 / 10000 倍：\n'
            f'    {"、".join(bad)}\n'
            f'  说明这张表的列语义改过（例如万分比改成毫秒），但 xlsx 没同步。\n'
            f'  处理：重跑「生成模板.bat --force」（会按字段名捞回已录入的数据），'
            f'或让工具改动方补跑一次单位迁移')


def read_kv_xlsx(path, table):
    """读键值表：单行表头，第 2 行起每种参数一行。"""
    if load_workbook is None:
        raise RuntimeError('需要 openpyxl：pip install openpyxl')
    spec = KV[table]
    wb = load_workbook(path, data_only=True)
    ws = pick_sheet(wb, spec['sheet'], path)
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise RuntimeError(f'{os.path.basename(path)} 是空表')

    head = [str(c).strip() if c is not None else '' for c in rows[0]][:4]
    if head != KV_HEAD:
        raise RuntimeError(
            f'{os.path.basename(path)} 第 1 行表头应为 {KV_HEAD}，实际 {head}\n'
            f'  （键值表是单行表头，不要按行式表的三行表头来改）')

    out = []
    for i, r in enumerate(rows[1:], start=2):
        if not r or blank(r[0]):
            continue
        out.append({
            'key': str(r[0]).strip(),
            'value': r[3] if len(r) > 3 else None,
            'row': i,
        })

    # 单位守卫（键值表版）：说明列里必须写明「万分比」/「毫秒」
    kt = {k[0]: k[1] for k in schema.KV_TABLES[table]['keys']}
    bad = []
    for r in rows[1:]:
        if not r or blank(r[0]):
            continue
        key = str(r[0]).strip()
        ct = kt.get(key)
        if ct is None:
            continue
        need = '毫秒' if schema.is_ms(ct) else ('万分比' if schema.is_wf(ct) else None)
        if not need:
            continue
        got = str(r[2]).strip() if len(r) > 2 and r[2] is not None else ''
        if need not in got:
            bad.append(f'{key}（说明应含「{need}」，实际「{got}」）')
    if bad:
        raise RuntimeError(
            f'{os.path.basename(path)} 的模板是旧单位，导出会整体差 10 / 10000 倍：\n'
            f'    {"、".join(bad)}\n'
            f'  处理：重跑「生成模板.bat --force」或让工具改动方补跑一次单位迁移')
    return out


def parse_effect_cell(cell):
    """复刻 GameConfig._parseEffectCell：<id>[:value][@chance][#stacks]

    返回 (buffId, value, chance, stacks, wf_errors) 或 None（语法错误）。
    value / chance 在配置里是**万分比**，这里 ÷10000 还原成小数；
    wf_errors 记录「本该填万分比却填了小数」的情况，由调用方按错误报出。

    校验逻辑在 TS 与 Python 各有一份，改动语法时两边都要改。
    """
    s = ''.join(str(cell).split())
    if not s:
        return None
    i = 0
    while i < len(s) and (s[i].isalnum() or s[i] == '_') and s[i].isascii():
        i += 1
    buff = s[:i]
    if not buff:
        return None
    value = chance = stacks = None
    wf_errors = []
    while i < len(s):
        mark = s[i]
        if mark not in ':@#':
            return None
        i += 1
        j = i
        while j < len(s) and (s[j].isdigit() or s[j] in '.+-'):
            j += 1
        raw = s[i:j]
        if not raw:
            return None
        try:
            n = float(raw)
        except ValueError:
            return None
        if mark in ':@':
            if not float(n).is_integer():
                wf_errors.append(
                    f'{mark}{raw} 是小数，万分比要填整数：{int(round(n * 10000))}')
            if mark == ':':
                value = n / 10000
            else:
                chance = n / 10000
        else:
            stacks = int(n)
        i = j
    return buff, value, chance, stacks, wf_errors


# ---------------------------------------------------------------------
# 行式表：单元格 → 记录（只做类型转换，不做跨表校验）
# ---------------------------------------------------------------------
def build_rows(table, raw_rows, errors, warns):
    spec = TABLES[table]
    out = []

    for idx, raw in enumerate(raw_rows, start=DATA_START_ROW):
        if all(blank(raw.get(c)) for c in spec['cols']):
            continue  # 空行忽略

        row = {}
        for c in spec['cols']:
            v = raw.get(c)
            if blank(v):
                # 空串有业务含义的列（如 anim.anim）：留空也要写成 ''
                if c in spec['empty_ok']:
                    row[c] = ''
                continue
            if c in spec['wf']:
                # 万分比列：必须是整数。填小数 = 忘了乘 10000，直接拦死，
                # 否则会被取整成 0（伤害全没）或错一百倍，跑起来都不报错。
                n, bad = wf_int(v)
                if bad is not None:
                    errors.append(
                        f'{table} 第 {idx} 行 {c} = {bad} 是小数。'
                        f'所有小数值都按万分比填整数：{bad} → {int(round(bad * 10000))}')
                    continue
                if n is None:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是数字')
                    continue
                row[c] = n
            elif c in spec['ms']:
                # 毫秒列：同样必须是整数。填 1.7 这种小数多半是想写 1.7 秒，
                # 直接报出来应该填 1700，不让它静默变成 1ms。
                n, bad = wf_int(v)
                if bad is not None:
                    errors.append(
                        f'{table} 第 {idx} 行 {c} = {bad} 是小数。'
                        f'时间一律填整数毫秒：{bad} → {int(round(bad * 1000))}')
                    continue
                if n is None:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是数字')
                    continue
                row[c] = n
            elif c in spec['ints']:
                n = to_number(v, as_int=True)
                if n is None:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是整数')
                    continue
                row[c] = n
            elif c in spec['floats']:
                n = to_number(v)
                if n is None:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是数字')
                    continue
                row[c] = n
            elif c in spec['bools']:
                b = to_bool(v)
                if b is None:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是布尔值'
                                  f'（可写 true / false / 1 / 0）')
                    continue
                row[c] = b
            elif c in spec['json']:
                # 对象列（如 buff.stats）：格子里是 JSON 文本，这里 parse 回对象
                try:
                    obj = json.loads(str(v).strip())
                except ValueError:
                    errors.append(f'{table} 第 {idx} 行 {c} = "{v}" 不是合法 JSON'
                                  f'（应形如 {{"atk": 3000}}）')
                    continue
                if not isinstance(obj, dict):
                    errors.append(f'{table} 第 {idx} 行 {c} 应为 JSON 对象，实际是 {type(obj).__name__}')
                    continue
                # 对象内部也可能是万分比（buff.stats），照样不许填小数
                known = spec['obj_wf'].get(c, ())
                bad_obj = False
                for k in known:
                    x = obj.get(k)
                    if isinstance(x, float) and not x.is_integer():
                        errors.append(
                            f'{table} 第 {idx} 行 {c}.{k} = {x} 是小数。'
                            f'属性百分比也按万分比填整数：{x} → {int(round(x * 10000))}')
                        bad_obj = True
                if bad_obj:
                    continue
                # 拼错的子键会被运行时静默忽略（效果凭空消失），按告警提示
                for k in obj:
                    if known and k not in known:
                        warns.append(f'{table} 第 {idx} 行 {c} 里有未知键 "{k}"，'
                                     f'运行时会被忽略（只认 {"/".join(known)}）')
                row[c] = obj
            else:
                row[c] = str(v).strip()

        for c in spec['required']:
            if c not in row:
                errors.append(f'{table} 第 {idx} 行缺少必填列 {c}')

        # 键顺序按列定义，输出更稳定
        out.append({'__row': idx, **{c: row[c] for c in spec['cols'] if c in row}})
    return out


def build_kv(table, raw_rows, errors):
    """键值表：组装成扁平对象。"""
    spec = KV[table]
    data = {}
    seen = {}
    bad = set()   # 已经报过错的键，别再算成「缺失」重复刷一遍

    for item in raw_rows:
        key, v, idx = item['key'], item['value'], item['row']
        if key not in spec['names']:
            errors.append(f'{table} 第 {idx} 行：未知参数 "{key}"。'
                          f'要加新参数请先在 schema.py 里登记，再重跑 gen-templates.py --force')
            continue
        if key in seen:
            errors.append(f'{table} 第 {idx} 行：参数 "{key}" 与第 {seen[key]} 行重复')
            continue
        seen[key] = idx

        if blank(v):
            continue  # 留空 = 用代码默认值，不写进 JSON

        if key in spec['lists']:
            arr = to_list(v)
            if arr is None:
                errors.append(f'{table} 第 {idx} 行 {key} = "{v}" 不是逗号分隔的数字列表'
                              f'（应形如 5000,10000,20000,30000）')
                bad.add(key)
                continue
            if key in spec['list_wf']:
                dec = [x for x in arr if isinstance(x, float) and not x.is_integer()]
                if dec:
                    errors.append(
                        f'{table} 第 {idx} 行 {key} 里有小数 {dec}。'
                        f'万分比数组要填整数：0.5 倍速填 5000')
                    bad.add(key)
                    continue
            data[key] = arr
        elif key in spec['wf']:
            n, dec = wf_int(v)
            if dec is not None:
                errors.append(
                    f'{table} 第 {idx} 行 {key} = {dec} 是小数。'
                    f'所有小数值都按万分比填整数：{dec} → {int(round(dec * 10000))}')
                bad.add(key)
                continue
            if n is None:
                errors.append(f'{table} 第 {idx} 行 {key} = "{v}" 不是数字')
                bad.add(key)
                continue
            data[key] = n
        elif key in spec['ms']:
            n, dec = wf_int(v)
            if dec is not None:
                errors.append(
                    f'{table} 第 {idx} 行 {key} = {dec} 是小数。'
                    f'时间一律填整数毫秒：{dec} → {int(round(dec * 1000))}')
                bad.add(key)
                continue
            if n is None:
                errors.append(f'{table} 第 {idx} 行 {key} = "{v}" 不是数字')
                bad.add(key)
                continue
            data[key] = n
        elif key in spec['ints'] or key in spec['floats']:
            n = to_number(v, as_int=key in spec['ints'])
            if n is None:
                errors.append(f'{table} 第 {idx} 行 {key} = "{v}" 不是数字')
                bad.add(key)
                continue
            data[key] = n
        elif schema.is_bool_type(spec['types'][key]):
            b = to_bool(v)
            if b is None:
                errors.append(f'{table} 第 {idx} 行 {key} = "{v}" 不是布尔值'
                              f'（可写 true / false / 1 / 0）')
                bad.add(key)
                continue
            data[key] = b
        else:
            data[key] = str(v).strip()

    missing = [k for k in spec['names'] if k not in data and k not in bad]
    if missing:
        errors.append(f'{table} 缺少参数 {", ".join(missing)}'
                      f'（行被删了？这些键代码会直接读，缺了会 undefined）')
    return data


# ---------------------------------------------------------------------
# 跨表校验：依赖顺序解析，边解析边更新上下
# ---------------------------------------------------------------------
class Ctx:
    def __init__(self, char_ids, buff_ids, skill_keys,
                 skill_ms=None, skill_target_ms=1450):
        self.char_ids = char_ids        # set[str]
        self.buff_ids = buff_ids        # set[str]
        self.skill_keys = skill_keys    # set[(charId, slot)]
        self.skill_ms = skill_ms or {}          # (charId, slot) -> 演出时长(毫秒)
        self.skill_target_ms = skill_target_ms  # battle.skillTargetTime，duration=0 时的兜底


def row_label(table, row):
    """给报错用的行标识：取前两个字段的值，比裸行号好定位。"""
    cols = TABLES[table]['cols'][:2]
    vals = [str(row.get(c)) for c in cols if row.get(c) is not None]
    return ' '.join(vals) if vals else f'第 {row["__row"]} 行'


def check_character(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行'
    rid = row['id']
    if rid in st['ids']:
        errors.append(f'{tag}：id "{rid}" 与第 {st["ids"][rid]} 行重复')
    else:
        st['ids'][rid] = row['__row']
    if 'accent' in row and not (row['accent'].startswith('#') and len(row['accent']) == 7):
        warns.append(f'{tag} ({rid})：accent "{row["accent"]}" 不是 #rrggbb 格式')
    if row.get('critRate') is not None and not (0 <= row['critRate'] <= 10000):
        warns.append(f'{tag} ({rid})：critRate = {row["critRate"]} 超出 0~10000（万分比，10000 = 100%）')


def check_buff(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行'
    rid = row['id']
    if rid in st['ids']:
        errors.append(f'{tag}：buff 的 id "{rid}" 与第 {st["ids"][rid]} 行重复'
                      f'（效果格按 id 引用，重复会让引用指向不明）')
    else:
        st['ids'][rid] = row['__row']
    sign = row.get('sign')
    if sign is not None and sign not in (-1, 0, 1):
        errors.append(f'{tag} ({rid})：sign = {sign}，只允许 -1 / 1 / 0')


def check_spine(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行'
    rid = row['id']
    if rid in st['ids']:
        errors.append(f'{tag}：角色 "{rid}" 在 spine 表里出现了多次（一个角色只能有一套骨骼配置）')
    else:
        st['ids'][rid] = row['__row']
    if rid not in ctx.char_ids:
        errors.append(f'{tag}：id "{rid}" 在 character 表里不存在')


def check_anim(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行'
    cid = row['charId']
    kind = row['kind']
    if cid not in ctx.char_ids:
        errors.append(f'{tag}：charId "{cid}" 在 character 表里不存在')
    if kind not in ANIM_KINDS:
        errors.append(f'{tag}：kind "{kind}" 无法识别，只认 {"/".join(sorted(ANIM_KINDS))}')
    key = (cid, kind)
    if kind in ('idle', 'run', 'hurt') and key in st['kinds']:
        errors.append(f'{tag}：{cid} 的 {kind} 与第 {st["kinds"][key]} 行重复'
                      f'（待机 / 移动 / 受击各只能有一条）')
    else:
        st['kinds'].setdefault(key, row['__row'])


def check_skill(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行'
    cid, slot = row['charId'], row['slot']
    if cid not in ctx.char_ids:
        errors.append(f'{tag}：charId "{cid}" 在 character 表里不存在')
    if slot < 1 or slot > 4:
        warns.append(f'{tag}：slot 一般取 1~4，当前 {slot}')
    key = (cid, slot)
    if key in st['keys']:
        errors.append(f'{tag}：与第 {st["keys"][key]} 行重复（同一角色同一 slot 只能有一个技能）')
    else:
        st['keys'][key] = row['__row']
    if row.get('duration') is not None and row['duration'] < 0:
        warns.append(f'{tag}：duration 为负，运行时按 0 处理（退用 battle.skillTargetTime）')


def check_hit(row, ctx, st, errors, warns):
    tag = f'第 {row["__row"]} 行（{row["charId"]} 槽 {row["slot"]}）'
    cid, slot = row['charId'], row['slot']

    if cid not in ctx.char_ids:
        errors.append(f'{tag}：charId "{cid}" 在 character 表里不存在')
    elif (cid, slot) not in ctx.skill_keys:
        errors.append(f'{tag}：skill 表里没有这个技能。若这是 typo，改正 charId / slot；'
                      f'若是故意删了技能，请把这组打击点行一起删掉'
                      f'（孤儿打击点运行时会整组忽略，等于该技能悄悄退回默认 1 倍伤害）')

    # 段号是这段打击点的身份：charId + slot + hit 三者一起必须唯一。
    # 重复不会崩溃，只会让两段在同一时刻各结算一次（静默双倍伤害），按错误拦住。
    hit_no = row.get('hit')
    if hit_no is not None:
        key = (cid, slot, hit_no)
        if key in st['segs']:
            errors.append(f'{tag} 第 {hit_no} 段：与第 {st["segs"][key]} 行的 '
                          f'charId+slot+hit 完全相同。两段会在同一时刻各结算一次，'
                          f'表现为一次出手打出两下；请改成不同的段号')
        else:
            st['segs'][key] = row['__row']

    at = row.get('at')
    if at is not None:
        # at 是「距技能动画开始的毫秒数」，天然的上限就是本技能的演出时长。
        # 超出不会崩，只会被 clamp 到动画末尾 —— 多段全挤在同一时刻结算，
        # 表现为一次出手打出十几下，所以必须逐条提示。
        limit = ctx.skill_ms.get((cid, slot)) or 0
        if limit <= 0:
            limit = ctx.skill_target_ms
        if at < 0:
            warns.append(f'{tag}：at = {at} 是负数，运行时按动画开头处理')
        elif at > limit:
            warns.append(
                f'{tag}：at = {at}ms 超出本技能演出时长 {limit}ms，'
                f'运行时会被钳到动画末尾（多段会挤在同一时刻结算）')

    used = []
    for i in range(1, MAX_HIT_EFFECTS + 1):
        cell = row.get(f'e{i}')
        if not cell:
            continue
        used.append(i)
        parsed = parse_effect_cell(cell)
        if parsed is None:
            errors.append(f'{tag} 第 {i} 格："{cell}" 语法无法识别'
                          f'（应为 <buff>[:value][@chance][#stacks]）')
            continue
        buff_id, value, chance, _stacks, wf_errors = parsed
        for msg in wf_errors:
            errors.append(f'{tag} 第 {i} 格：{msg}')
        if buff_id not in ctx.buff_ids:
            errors.append(f'{tag} 第 {i} 格：buff "{buff_id}" 在 buff 表里不存在')
        if chance is not None and chance > 1:
            warns.append(f'{tag} 第 {i} 格：触发概率 {chance:.0%} 超过 100%'
                         f'（万分比里 10000 就是 100%）')
        if value is not None and value != 0 and abs(value) < 0.001:
            warns.append(f'{tag} 第 {i} 格：value = {value} 小得异常，是不是忘了乘 10000？')
    if used and (used[0] != 1 or used[-1] - used[0] + 1 != len(used)):
        warns.append(f'{tag}：效果格不连续（填了 e{"/e".join(map(str, used))}），应从 e1 起依次填')
    if not used:
        warns.append(f'{tag}：这一段没有任何效果，运行时不会结算')


CHECKS = {
    'character': check_character,
    'buff': check_buff,
    'spine': check_spine,
    'anim': check_anim,
    'skill': check_skill,
    'hit': check_hit,
}

NEW_STATE = {
    'character': lambda: {'ids': {}},
    'buff': lambda: {'ids': {}},
    'spine': lambda: {'ids': {}},
    'anim': lambda: {'kinds': {}},
    'skill': lambda: {'keys': {}},
    'hit': lambda: {'segs': {}},
}


# ---------------------------------------------------------------------
# 差异比较
# ---------------------------------------------------------------------
def strip_internal(rows):
    return [{k: v for k, v in r.items() if not k.startswith('__')} for r in rows]


# 各表主键，用于差异对齐。必须唯一确定一行，否则 diff 会错位。
# 与 CHECKS 里各表的判重口径保持一致。
ROW_KEY = {
    'character': ('id',),
    'spine': ('id',),
    'anim': ('charId', 'kind'),
    'buff': ('id',),
    'skill': ('charId', 'slot'),
    'hit': ('charId', 'slot', 'hit'),
}


def row_key(table, row):
    """取一行的主键值；缺任一键字段时返回 None（这种行退回索引对比）。"""
    fields = ROW_KEY.get(table)
    if not fields:
        return None
    vals = tuple(row.get(f) for f in fields)
    if any(v is None or v == '' for v in vals):
        return None
    return vals


def key_text(table, row):
    k = row_key(table, row)
    return '·'.join(str(v) for v in k) if k else row_brief(table, row)


def brief_list(table, rows, limit=8):
    """把若干行压成一行摘要：E200004·2·1、E200004·2·2 …… 共 10 行"""
    names = [key_text(table, r) for r in rows[:limit]]
    more = f' …… 共 {len(rows)} 行' if len(rows) > limit else ''
    return '、'.join(names) + more


def diff_rows(table, old, new, cols):
    """按主键对齐后比较；返回 (新增行[], 删除行[], 修改[(key, old, new)])

    不用索引对齐：中间插一行会让它之后的每一行都「看起来改了」，
    输出成一片改动，容易误判成配错了。主键对齐只报真正变化的行。
    """
    old_map, new_map = OrderedDict(), OrderedDict()
    for r in old:
        k = row_key(table, r)
        if k is not None:
            old_map[k] = r
    for r in new:
        k = row_key(table, r)
        if k is not None:
            new_map[k] = r

    # 主键不全的行没有稳定标识，按出现顺序补到末尾，避免被当成「删除」
    old_left = [r for r in old if row_key(table, r) is None]
    new_left = [r for r in new if row_key(table, r) is None]
    for i, r in enumerate(new_left):
        k = ('?', i)
        new_map[k] = r
        if i < len(old_left):
            old_map[k] = old_left[i]

    added = [new_map[k] for k in new_map if k not in old_map]
    removed = [old_map[k] for k in old_map if k not in new_map]
    changed = [(k, old_map[k], new_map[k]) for k in new_map
               if k in old_map
               and any(old_map[k].get(c) != new_map[k].get(c) for c in cols)]
    return added, removed, changed


def row_brief(table, row):
    cols = TABLES[table]['cols'][:2]
    return ' '.join(str(row.get(c)) for c in cols if row.get(c) is not None)


def diff_kv(old, new):
    """键值表差异：返回 [(key, old, new)]"""
    out = []
    for k in sorted(set(old) | set(new)):
        if old.get(k) != new.get(k):
            out.append((k, old.get(k), new.get(k)))
    return out


# ---------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description='xlsx → JSON 配置导出（默认只预览）')
    ap.add_argument('--write', action='store_true', help='真正写入 JSON（默认只预览差异）')
    ap.add_argument('--preview', action='store_true',
                    help='强制只看差异、不写盘（优先级高于 --write，双击 bat 的预览开关走这里）')
    ap.add_argument('--only', choices=ORDER, help='只导出其中一张表')
    ap.add_argument('--out-dir', default=JSON_DIR,
                    help='输出目录（默认 config-templates/json）')
    ap.add_argument('--tpl-dir', default=TPL_DIR, help='模板目录（默认 config-templates）')
    ap.add_argument('--quiet', action='store_true', help='只打印结论')
    args = ap.parse_args()
    if args.preview:
        args.write = False

    tables = [t for t in ORDER if not args.only or t == args.only]

    # ---- 上下文起点：没参与本次导出的表，用现有 JSON 兜底 ----
    def json_ids(name, field='id'):
        return {r.get(field) for r in (load_json(name) or {}).get('rows', []) if r.get(field)}

    def skill_ms_map(rows):
        return {(r.get('charId'), r.get('slot')): r.get('duration') or 0 for r in rows}

    ctx = Ctx(
        char_ids=json_ids('character'),
        buff_ids=json_ids('buff'),
        skill_keys={(r.get('charId'), r.get('slot'))
                    for r in (load_json('skill') or {}).get('rows', [])},
        skill_ms=skill_ms_map((load_json('skill') or {}).get('rows', [])),
        # duration 填 0 时运行时会退用 battle.skillTargetTime 来排打击点，
        # 校验口径必须与它一致，否则「0 时段的技能」会被误报越界。
        skill_target_ms=(load_json('battle') or {}).get('skillTargetTime') or 1450,
    )

    all_errors, all_warns = [], []
    parsed_rows = {}    # 行式表：{table: [row]}
    parsed_kv = {}      # 键值表：{table: dict}

    for t in tables:
        path = os.path.join(args.tpl_dir, f'{t}.xlsx')
        if not os.path.exists(path):
            all_errors.append(f'找不到 {display_path(path)}（先跑「生成模板.bat」）')
            continue

        # Excel / WPS 打开文件时会留一个 ~$xxx.xlsx 锁文件。此时磁盘上的内容
        # 可能是「保存前」的版本，导出结果看着成功、其实是旧的。
        if os.path.exists(os.path.join(args.tpl_dir, f'~${t}.xlsx')):
            all_warns.append(
                f'{t}.xlsx 正在 Excel / WPS 里打开：读到的是磁盘上最后一次保存的内容，'
                f'刚改的还没 Ctrl+S 就导不出来')

        is_kv = t in KV
        try:
            if is_kv:
                raw = read_kv_xlsx(path, t)
            else:
                raw = read_sheet_xlsx(path, t)
        except Exception as e:  # 文件被 WPS / Excel 独占等
            all_errors.append(f'读取 {os.path.basename(path)} 失败：{e}')
            continue

        if is_kv:
            parsed_kv[t] = build_kv(t, raw, all_errors)
            continue

        rows = build_rows(t, raw, all_errors, all_warns)
        st = NEW_STATE[t]()
        for row in rows:
            CHECKS[t](row, ctx, st, all_errors, all_warns)
        parsed_rows[t] = rows

        # 边解析边更新上下文：同一次导出里改了 character 的 id，
        # 后面的 spine / anim / skill / hit 就该按新 id 校验，而不是按旧 JSON。
        if t == 'character':
            ctx.char_ids = {r['id'] for r in rows if 'id' in r} or ctx.char_ids
        elif t == 'buff':
            ctx.buff_ids = {r['id'] for r in rows if 'id' in r} or ctx.buff_ids
        elif t == 'skill':
            ctx.skill_keys = {(r['charId'], r['slot']) for r in rows
                              if 'charId' in r and 'slot' in r} or ctx.skill_keys
            # duration 改了要立刻反映到 hit 的越界校验上，所以这里一起更新
            ctx.skill_ms = skill_ms_map(rows) or ctx.skill_ms

    # ---- 全局一致性：其它表里不该出现指向不存在角色的行 ----
    def effective_rows(name):
        if name in parsed_rows:
            return strip_internal(parsed_rows[name])
        return (load_json(name) or {}).get('rows', [])

    if 'character' in parsed_rows:
        for dep, field in (('spine', 'id'), ('anim', 'charId'),
                           ('skill', 'charId'), ('hit', 'charId')):
            if dep in parsed_rows:
                continue  # 本次已按新角色表校验过
            for r in (load_json(dep) or {}).get('rows', []):
                if r.get(field) and r[field] not in ctx.char_ids:
                    all_warns.append(
                        f'{dep}.json 里的 {r[field]} 在 character 表里已不存在'
                        f'（你刚改了角色 id？记得同步 {dep}.xlsx 并导出）')

    # ---- 差异 ----
    plans = []
    for t in tables:
        if t in KV:
            if t not in parsed_kv:
                continue
            old_doc = load_json(t) or {}
            old = {k: v for k, v in old_doc.items() if not k.startswith('_')}
            new = parsed_kv[t]
            changes = diff_kv(old, new)
            plans.append(dict(table=t, kv=True, old=old, new=new, changes=changes,
                              n=len(new)))
        else:
            if t not in parsed_rows:
                continue
            old_rows = (load_json(t) or {}).get('rows', [])
            new_rows = strip_internal(parsed_rows[t])
            added, removed, changed = diff_rows(t, old_rows, new_rows, TABLES[t]['cols'])
            plans.append(dict(table=t, kv=False, old_rows=old_rows, new_rows=new_rows,
                              added=added, removed=removed, changed=changed,
                              n=len(new_rows)))

    # ---- 报告 ----
    if not args.quiet:
        print('=' * 66)
        for p in plans:
            t = p['table']
            if p['kv']:
                print(f'{t}.xlsx → {t}.json   {p["n"]} 个参数   修改 {len(p["changes"])} 处')
                for k, a, b in p['changes'][:8]:
                    print(f'   {k}: {a!r} → {b!r}')
            else:
                print(f'{t}.xlsx → {t}.json   {p["n"]} 行   '
                      f'（新增 {len(p["added"])} / 删除 {len(p["removed"])} / '
                      f'修改 {len(p["changed"])}）')
                for k, a, b in p['changed'][:6]:
                    label = (f'第 {k[1] + 1} 行' if k[0] == '?' else key_text(t, b))
                    for c in TABLES[t]['cols']:
                        if a.get(c) != b.get(c):
                            print(f'   [{label}] {c}: '
                                  f'{a.get(c)!r} → {b.get(c)!r}')
                if len(p['changed']) > 6:
                    print(f'   …… 另有 {len(p["changed"]) - 6} 行有改动')
                if p['added']:
                    print('   新增：' + brief_list(t, p['added']))
                if p['removed']:
                    print('   删除：' + brief_list(t, p['removed']))
        print('=' * 66)

    if all_warns:
        print(f'\n⚠ 告警 {len(all_warns)} 条（不阻止写入）：')
        for w in all_warns:
            print('  -', w)

    if all_errors:
        print(f'\n✖ 错误 {len(all_errors)} 条，已中止，未写入任何文件：')
        for e in all_errors:
            print('  -', e)
        return 1

    total_change = 0
    for p in plans:
        total_change += len(p['changes']) if p['kv'] else (
            len(p['added']) + len(p['removed']) + len(p['changed']))
    if total_change == 0:
        print('\n✔ 模板与 JSON 完全一致，无需导出。')
        return 0

    if not args.write:
        print(f'\n（预览模式）共 {total_change} 处差异，未写入。'
              f'确认无误后去掉 --preview 再跑一次（或直接双击「导出配置.bat」）。')
        return 0

    # ---- 写盘 ----
    # 先把所有文档在内存里组装完，再统一落盘：避免写到一半失败，
    # 出现 character.json 已更新、skill.json 还是旧的这种不一致状态。
    os.makedirs(args.out_dir, exist_ok=True)
    # 备份放在 config-templates/.backup/，不塞进 json/（那是给人验收的产物目录），
    # 更不能放 assets 下（Cocos asset-db 会把多出来的目录一起扫成资源）。
    if os.path.abspath(args.out_dir) == os.path.abspath(JSON_DIR):
        backup_dir = os.path.join(TPL_DIR, '.backup')
    else:
        backup_dir = os.path.join(args.out_dir, '.backup')
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')

    payloads = []
    for p in plans:
        t = p['table']
        old_doc = load_json(t) or {}
        if p['kv']:
            # 键值表：JSON 顶层就是键值，没有 rows
            doc = {k: v for k, v in old_doc.items() if not k.startswith('_')}
            doc.update(p['new'])
        else:
            doc = {k: v for k, v in old_doc.items() if not k.startswith('_')}
            doc['rows'] = p['new_rows']
        payloads.append((t, os.path.join(args.out_dir, f'{t}.json'), doc))

    backed_up = 0
    for t, dst, doc in payloads:
        if os.path.exists(dst):
            shutil.copy2(dst, os.path.join(backup_dir, f'{t}-{stamp}.json'))
            backed_up += 1

    for t, dst, doc in payloads:
        with io.open(dst, 'w', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')

    for t, dst, doc in payloads:
        n = len(doc) if t in KV else len(doc.get('rows', []))
        unit = '个参数' if t in KV else '行'
        print(f'✔ 已写入 {display_path(dst)}（{n} {unit}）')

    if backed_up:
        print(f'\n旧文件已备份到 {display_path(backup_dir)}，'
              f'需要回滚就拷回去或 git checkout。')
    print('')
    print('下一步：')
    print('  1. 看一眼 config-templates/json/ 里的产物对不对')
    print('  2. 双击 tools/导入客户端.bat，推到 assets/resources/config/')
    print('  3. 回 Cocos 预览跑一次，看控制台有没有配置告警')
    return 0


if __name__ == '__main__':
    sys.exit(main())
