#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成配表模板（xlsx）与 TS 类型定义（ConfigTypes.ts）。

★ 配置流程：xlsx 是编辑入口，导出成 JSON 才是运行时数据。
    日常：改 config-templates/*.xlsx  →  双击「导出配置.bat」  →  双击 tools/导入客户端.bat
    本脚本只在「首次建模板」或「schema.py 改了列」时跑一次，平时不用动
    （双击 config-templates/生成模板.bat 即可）。

用法：
    python config-templates/gen-templates.py            # 只生成还不存在的 xlsx
    python config-templates/gen-templates.py --force    # 重建全部 xlsx（会保留已录入的数据）

产物：
    config-templates/character.xlsx   角色数值
    config-templates/spine.xlsx       骨骼资源
    config-templates/anim.xlsx        动画引用
    config-templates/buff.xlsx        效果定义
    config-templates/skill.xlsx       技能
    config-templates/hit.xlsx         打击点
    config-templates/battle.xlsx      全局参数（键值表）
    assets/scripts/fight/ConfigTypes.ts

数据页表头是三行：
    第 1 行  备注（几个字，只说明「这个字段是什么」）
    第 2 行  字段名（写进 JSON 的键）
    第 3 行  数据类型（int / string / bool，或任意 TS 类型表达式）
    第 4 行起 数据
规则、取值范围、常见坑一律写在同文件的「配置规则」页，不挤在备注行。

★ 不配小数：所有「本质是小数」的字段都以万分比整数填写（0.45 填 4500），
  数据页类型列显示 int，schema.py 里类型标 wf，运行时由 GameConfig 的 wf() ÷10000。

列定义来自 config-templates/schema.py，改列只改那一个文件。

⚠ 覆盖保护：xlsx 已存在时本脚本默认跳过。因为 xlsx 现在是配置真源，
   每次重跑都从 JSON 重建会把你在 Excel 里录入、但还没导出的改动静默冲掉。
   确实要重建时加 --force —— 它会先把旧表里的数据按字段名捞出来再写新表。
"""

import argparse
import io
import json
import math
import os
import re
import sys

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema  # noqa: E402  列定义唯一来源

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'assets', 'resources', 'config')
OUT = os.path.join(ROOT, 'config-templates')

# 数据页表头位置（与 export-config.py 对齐）
REMARK_ROW = 1
NAME_ROW = 2
TYPE_ROW = 3
DATA_START = 4

# ---------- 样式 ----------
HEAD_FILL = PatternFill('solid', fgColor='2F4F5F')
HEAD_FONT = Font(bold=True, color='FFFFFF', size=10)
REMARK_FILL = PatternFill('solid', fgColor='F2F6F8')
REMARK_FONT = Font(size=9, color='52646E')
TYPE_FILL = PatternFill('solid', fgColor='E4EEF3')
TYPE_FONT = Font(size=9, name='Consolas', color='2F4F5F')
TITLE_FONT = Font(bold=True, size=14, color='1F3B4D')
H2_FONT = Font(bold=True, size=11, color='2F4F5F')
BODY_FONT = Font(size=10)
MONO_FONT = Font(size=10, name='Consolas')
THIN = Side(style='thin', color='C8D6DE')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical='top')
TOP = Alignment(vertical='top')
CENTER = Alignment(horizontal='center', vertical='center')


def cjk_len(s):
    """粗略估算显示宽度：中文按 2 计。"""
    return sum(2 if ord(c) > 127 else 1 for c in str(s))


# =====================================================================
# 数据页
# =====================================================================

def write_data_sheet(ws, cols, widths, rows):
    """三行表头：备注 / 字段名 / 数据类型，第 4 行起是数据。

    为什么分三行：字段名要短（方便引用），备注要短（方便一屏看完），
    数据类型要机器能读（生成 ConfigTypes.ts）。规则不写在这里，写进「配置规则」页。
    """
    names = [schema.col_name(c) for c in cols]

    for i, c in enumerate(cols, start=1):
        cell = ws.cell(row=REMARK_ROW, column=i, value=schema.col_remark(c))
        cell.fill = REMARK_FILL
        cell.font = REMARK_FONT
        cell.alignment = CENTER
        cell.border = BORDER

    for i, name in enumerate(names, start=1):
        cell = ws.cell(row=NAME_ROW, column=i, value=name)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = CENTER
        cell.border = BORDER
        ws.column_dimensions[get_column_letter(i)].width = widths.get(name, 12)

    for i, c in enumerate(cols, start=1):
        # 万分比存的就是整数，类型列显示 int（「万分比」写在备注行与规则页）
        cell = ws.cell(row=TYPE_ROW, column=i, value=schema.xlsx_type(schema.col_type(c)))
        cell.fill = TYPE_FILL
        cell.font = TYPE_FONT
        cell.alignment = CENTER
        cell.border = BORDER

    for ri, r in enumerate(rows, start=DATA_START):
        for ci, name in enumerate(names, start=1):
            v = r.get(name, '')
            # Excel 存不了对象 / 数组，写成 JSON 文本，导出时再 parse 回来
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            ws.cell(row=ri, column=ci, value=v)

    for row in ws.iter_rows(min_row=DATA_START, max_row=ws.max_row, max_col=len(names)):
        for cell in row:
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = TOP

    ws.row_dimensions[REMARK_ROW].height = 18
    ws.row_dimensions[NAME_ROW].height = 22
    ws.row_dimensions[TYPE_ROW].height = 18

    ws.freeze_panes = f'A{DATA_START}'
    ws.auto_filter.ref = f'A{NAME_ROW}:{get_column_letter(len(names))}{ws.max_row}'


def write_kv_sheet(ws, keys, widths, data):
    """键值表：单行表头「键名 / 类型 / 说明 / 值」，第 2 行起每种键一行。

    不做三行表头，因为键名本身就是身份，不需要额外的备注行——
    说明直接占一列，反而更宽裕。
    """
    head = ['键名', '类型', '说明', '值']
    for i, h in enumerate(head, start=1):
        cell = ws.cell(row=1, column=i, value=h)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = CENTER
        cell.border = BORDER
        ws.column_dimensions[get_column_letter(i)].width = widths[h]

    for ri, (name, raw_type, remark, long) in enumerate(keys, start=2):
        desc = f'{remark}｜{long}' if long else remark
        val = data.get(name, '')
        # 数组在 Excel 里写成逗号分隔（导出时再切回数字数组）
        if isinstance(val, (list, tuple)):
            val = ','.join(str(x) for x in val)
        vals = [name, schema.xlsx_type(raw_type), desc, val]
        for ci, v in enumerate(vals, start=1):
            cell = ws.cell(row=ri, column=ci, value=v)
            cell.border = BORDER
            cell.alignment = TOP if ci == 3 else CENTER
            cell.font = MONO_FONT if ci in (1, 2) else BODY_FONT
            if ci == 1:
                cell.fill = PatternFill('solid', fgColor='F2F6F8')

    ws.row_dimensions[1].height = 22
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = f'A1:D{ws.max_row}'


# =====================================================================
# 规则页
# =====================================================================
RULES_WIDTHS = [28, 16, 18, 18, 18, 22]


def write_rules_sheet(ws, blocks):
    """blocks: ('title'|'h2'|'p'|'note'|'table'|'blank', payload)

    table payload: (header, body[, spans])
      spans 是每列跨几格，合计 6；不传则均分。不同形状的表用不同跨度，
      否则「说明」列会被挤在窄格里疯狂换行。
    """
    total_width = sum(RULES_WIDTHS)
    for i, w in enumerate(RULES_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.sheet_view.showGridLines = False

    row = 1

    def style_range(r, c1, c2, font, fill=None, align=None):
        for c in range(c1, c2 + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = font
            if fill:
                cell.fill = fill
            if align:
                cell.alignment = align
            cell.border = BORDER

    def put(text, font, height=None):
        nonlocal row
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
        cell = ws.cell(row=row, column=1, value=text)
        cell.font = font
        cell.alignment = Alignment(wrap_text=True, vertical='top', indent=1)
        lines = max(1, math.ceil(cjk_len(text) / (total_width * 0.85)))
        ws.row_dimensions[row].height = height or max(15, 14.5 * lines + 4)
        row += 1

    for kind, payload in blocks:
        if kind == 'title':
            put(payload, TITLE_FONT, height=28)
        elif kind == 'h2':
            row += 1
            ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
            style_range(row, 1, 6, H2_FONT, PatternFill('solid', fgColor='E8F1F5'),
                        Alignment(vertical='center', indent=1))
            ws.cell(row=row, column=1).value = payload
            ws.row_dimensions[row].height = 22
            row += 1
        elif kind == 'p':
            put(payload, BODY_FONT)
        elif kind == 'note':
            put(payload, Font(size=10, italic=True, color='A0522D'))
        elif kind == 'blank':
            row += 1
        elif kind == 'table':
            header, body = payload[0], payload[1]
            spans = payload[2] if len(payload) > 2 else [1] * len(header)
            if sum(spans) != 6:
                raise ValueError(f'表 {header} 的 spans 合计 {sum(spans)}，应为 6')
            colw = []
            c = 0
            for sp in spans:
                colw.append(sum(RULES_WIDTHS[c:c + sp]))
                c += sp

            col = 1
            for i, h in enumerate(header):
                sp = spans[i]
                if sp > 1:
                    ws.merge_cells(start_row=row, start_column=col,
                                   end_row=row, end_column=col + sp - 1)
                style_range(row, col, col + sp - 1, HEAD_FONT, HEAD_FILL,
                            Alignment(horizontal='center', vertical='center', wrap_text=True))
                ws.cell(row=row, column=col).value = h
                col += sp
            ws.row_dimensions[row].height = 20
            row += 1

            for rec in body:
                col = 1
                maxlines = 1
                for i, val in enumerate(rec):
                    sp = spans[i]
                    if sp > 1:
                        ws.merge_cells(start_row=row, start_column=col,
                                       end_row=row, end_column=col + sp - 1)
                    f = MONO_FONT if i == 0 else BODY_FONT
                    style_range(row, col, col + sp - 1, f, None, WRAP)
                    ws.cell(row=row, column=col).value = val
                    maxlines = max(maxlines, math.ceil(cjk_len(val) / max(4, colw[i] - 1)))
                    col += sp
                ws.row_dimensions[row].height = max(15, 14 * maxlines + 4)
                row += 1
            row += 1
        else:
            raise ValueError(f'unknown block {kind}')


# =====================================================================
# 规则文本
# =====================================================================

HEADER_NOTE = ('数据页表头是三行：第 1 行备注（几个字）、第 2 行字段名、第 3 行数据类型，'
               '第 4 行起才是数据。前 3 行别删、别调顺序——导出工具靠第 2 行认列。')

WF_NOTE = ('★ 一律不填小数。凡是「比例 / 倍数」的字段都用万分比整数：'
           '0.45 填 4500、1.6 倍填 16000、40% 填 4000。'
           '数据页「类型」列写的是 int，因为它存的确实是整数；'
           '程序读进来会自动 ÷10000 还原成小数，业务代码看到的仍是普通小数。'
           '★ 填成 0.45 这类小数会被导出工具直接拦下来。')

MS_NOTE = ('★ 凡是「时间」的字段都用整数毫秒：1.7 秒填 1700、0.35 秒填 350、2.5 秒填 2500。'
           '数据页「类型」列同样写 int；程序读进来会自动 ÷1000 还原成秒。'
           '★ 时间不要写成万分比——17000 到底是 1.7 秒还是 17000 毫秒，读的人分不清。'
           '★ 填成 1.7 这类小数会被导出工具直接拦下来。')

#: 规则页的列说明表怎么显示类型（万分比要点明，否则会被当普通整数）
def doc_type(raw):
    return schema.doc_type(raw)

SYNC_BLOCKS = [
    ('h2', '导出到 JSON'),
    ('p', '游戏只读 assets/resources/config/*.json，改完本表必须导出一次，否则等于没改。'),
    ('p', '① python config-templates/export-config.py —— 预览，不写盘，'
          '列出「新增 / 删除 / 修改」的条数与逐格样例；'
          '② 确认差异符合预期后加 --write：python config-templates/export-config.py --write。'),
    ('p', '只想导这一张表，加 --only 表名，例如 --only hit。'),
    ('note', '导出前会做校验：【错误】直接中止，一个字节都不写（必填缺失、类型不对、'
             '引用了不存在的角色 / buff / 技能、主键重复）。【告警】照写但会列出来。'),
    ('note', '本表由 gen-templates.py 生成（列定义在 schema.py）。xlsx 是配置真源，'
             '所以生成脚本对已存在的表默认跳过，不会覆盖你录入的数据。'),
]


def col_table(table):
    """列说明表，直接从 schema 生成，不手写。"""
    body = []
    for c in schema.TABLES[table]['cols']:
        body.append([
            schema.col_name(c),
            '是' if schema.col_required(c) else '否',
            doc_type(schema.col_type(c)),
            schema.col_long(c) or schema.col_remark(c),
        ])
    return ('table', (['列', '必填', '类型 / 范围', '说明'], body, [1, 1, 1, 3]))


def base_rules(table, intro):
    spec = schema.TABLES[table]
    return [
        ('title', f'{spec["sheet"]}表 · 配置规则（对应 assets/resources/config/{table}.json）'),
        ('p', f'Sheet「{spec["sheet"]}」是数据，本页是规则。'),
        ('note', HEADER_NOTE),
        ('note', WF_NOTE),
        ('note', MS_NOTE),
        ('h2', '1. 这张表是什么'),
        *[('p', s) for s in intro],
        ('h2', '2. 列说明'),
        col_table(table),
    ]


EXTRAS = {
    'character': [
        ('h2', '3. 改这里会牵连什么'),
        ('p', 'id 是主键，spine / anim / skill / hit 都用它关联。改 id 必须同步改另外四张表，'
              '否则那些行会变成孤儿（导出工具会报错拦住）。'),
        ('p', 'accent 只影响表现（血条 / 名字 / 选中态颜色），不影响数值。'),
        ('h2', '4. 常见错误对照'),
        ('table', (
            ['现象', '原因', '修法'],
            [
                ['角色不出场', 'id 与 battle 的 defaultHeroId 对不上', '核对 battle 表的默认角色 id'],
                ['血条颜色怪', 'accent 不是 #rrggbb 格式', '写成 #e2503c 这种 6 位十六进制'],
                ['打不动 / 秒杀', 'atk / def 量级不对', '对照同批角色的数值区间'],
            ],
            [2, 2, 2],
        )),
    ],

    'spine': [
        ('h2', '3. 坐标与缩放'),
        ('p', 'scale 负责把不同来源的骨骼统一到同一体高；anchorX / anchorY 是「骨架坐标系里'
              '的哪个点算作脚下站位点」，选身体中轴与脚底交点。'),
        ('p', 'headY 只用于定位头顶血条与飘字，调错的表现是血条飘在半空或埋进身体。'),
        ('p', 'flip：素材本身朝左时填 true，运行时整体镜像；不要靠负 scale 来翻转。'),
        ('h2', '4. 常见错误对照'),
        ('table', (
            ['现象', '原因', '修法'],
            [
                ['角色浮空 / 陷地', 'anchorY 取值不是脚底', '在 Spine 里量脚底的 Y'],
                ['角色朝向反了', '素材本身朝左却没填 flip', 'flip 填 true'],
                ['两个角色大小差很多', 'scale 没按体高归一', '以最高角色的身高为基准重算 scale'],
            ],
            [2, 2, 2],
        )),
    ],

    'anim': [
        ('h2', '3. 动画名必须与 Spine 工程一致'),
        ('p', 'anim 填的是 Spine 动画轨道的名字，拼错不会报错，只会表现为「动作不播放」。'
              '改 Spine 工程后记得回来核对这一列。'),
        ('p', 'duration 填骨架内原始时长的万分比（1.5 秒 → 15000）：运行时会用'
              '「原始时长 ÷ 目标时长」算播放倍速，这里填错会导致动作被莫名压快或拖慢。'),
        ('h2', '4. attack 有多个时'),
        ('p', '普攻可以配多个动画轮换，order 决定轮换顺序（升序，缺省按行序）。'
              '同一个 charId 下的 kind 不要重复出现两次以上（idle / run / hurt 各只该有一条）。'),
    ],

    'buff': [
        ('h2', '3. 一个 buff 能同时做四件事'),
        ('table', (
            ['维度', '字段', '什么时候生效'],
            [
                ['位移', 'distance / height / moveTime', '施加瞬间触发（击退、击飞）'],
                ['数值', 'value + valueType + sign + duration + tick', '施加瞬间结算，带 duration 时按 tick 周期结算'],
                ['控制', 'control', '存续期内被动判定'],
                ['属性', 'stats', '存续期内被动叠加'],
            ],
            [1, 3, 2],
        )),
        ('p', '所以「伤害 + 灼烧 + 减速」不必拆成三个 buff —— 一个 buff 全都能带，'
              'hit 里只占 e1 一个格。'),
        ('h2', '4. sign 与 value 的分工（最容易踩）'),
        ('p', 'value 只写绝对值倍数，方向完全由 sign 决定：sign = -1 伤害、1 治疗、0/缺省时'
              '才退回按 value 的正负号。'),
        ('note', '历史坑：早期只有 value 一个字段，伤害写成正数 1 于是被当成治疗，'
                 '所有技能命中都在给对手加血。现在方向一律看 sign，value 写正数。'),
        ('h2', '5. 常见错误对照'),
        ('table', (
            ['现象', '原因', '修法'],
            [
                ['技能给对手加血', 'sign 没填且 value 是正数', '伤害类 buff 显式填 sign = -1'],
                ['dot 只跳一次', 'duration 没填，或 tick 大于 duration', '填 duration，tick ≤ duration'],
                ['眩晕不生效', 'control 拼写错（如 stun 写成 sturn）', '只认 stun / root / silence'],
                ['层数叠不上去', 'stackMode 不是 stack', '改成 stack 并设 stackMax'],
            ],
            [2, 2, 2],
        )),
    ],

    'skill': [
        ('h2', '3. 打击点不在本表'),
        ('p', '具体打在什么时间、打出什么效果，全在 hit 表里配，用 charId + slot 关联本表的同一行。'),
        ('h2', '4. duration 与播放倍速'),
        ('p', '播放倍速 = Spine 动作原始时长 ÷ duration，钳制在 0.15~6 倍之间。'
              'duration 填得比原始时长短，动作被压快；填得长，动作被拖慢（看起来像卡顿）。'
              '通常直接填 Spine 里的原始时长最稳（如 1.45 秒 → 14500）。'),
        ('p', '右上角还有全局倍速开关（battle.speedOptions），两者相乘才是最终速度。'),
        ('h2', '5. cooldown 的起算点'),
        ('p', '冷却从「动作播完」开始计时，不是从按下按钮开始。所以两次同技能的最小间隔'
              '≈ duration + cooldown。演出期间冷却不递减，避免连招时冷却被演出时间白送。'),
        ('h2', '6. 常见错误对照'),
        ('table', (
            ['现象', '原因', '修法'],
            [
                ['角色没有技能按钮', '本表没有该角色的行，或 anim 为空', '补行 / 填 anim'],
                ['技能点了没反应', '能量不足或冷却中', '看 energyCost / cooldown'],
                ['技能动作播不完就切走', 'duration 远小于原始时长，倍速被钳在 6 倍', '把 duration 调到接近原始时长'],
                ['技能释放时角色不动', 'lunge 已停用，属预期行为', '需要位移就改动画，别指望 lunge'],
            ],
            [2, 2, 2],
        )),
    ],

    'hit': [
        ('h2', '3. 这张表怎么组织'),
        ('p', '一行 = 一个打击点。一个技能想打几下就写几行，运行时按 at 升序依次结算'
              '（at 相同时按 hit 序号）。'),
        ('p', '用 charId + slot 关联 skill 表：同一角色、同一槽位的所有行，组成该技能的打击点列表。'),
        ('h2', '4. at 怎么定（最常问）'),
        ('p', '秒数 = (at ÷ 10000) × (skill 表里的 duration ÷ 10000)。'
              '例：duration = 14500（1.45 秒）、at = 5600（0.56）→ 0.81 秒。'),
        ('p', '取值思路：在 Spine 编辑器里放一遍动作，找到武器或拳头「砸到对手」的那一帧，'
              '用「该帧时间 ÷ 动作总时长」算出 0~1 的比例，再 × 10000 填进来。'),
        ('p', '运行时会打印「打击点 0.81s」，直接对照就知道有没有对准，不用盲猜。'),
        ('note', '段号（hit）是这一行的身份：同一个 charId + slot 下不能重复。'
                 '重复时导出工具直接报错拦住，因为两段会在同一时刻各结算一次，'
                 '等于伤害悄悄翻倍，跑起来没有任何报错。留空会按行序自动编号，'
                 '可能跟手写的段号撞上，所以建议每行都显式填。'),
        ('h2', '5. 效果格语法'),
        ('p', '<buffId>[:<value>][@<chance>][#<stacks>]　（value 与 chance 都填万分比）'),
        ('table', (
            ['片段', '含义', '示例'],
            [
                ['buffId', 'buff 表里的 id，必填', 'dmg / burn / stun'],
                [':value', '覆盖数值（万分比）；留空用 buff 表默认值', 'dmg:16000 → 1.6 倍攻击'],
                ['@chance', '触发概率（万分比）', 'slow@4000 → 40% 概率'],
                ['#stacks', '叠层数，整数（不是万分比），向下取整，最小 1', 'dmg:16000#2'],
            ],
            [1, 3, 2],
        )),
        ('p', '三个参数顺序任意，空格会被忽略，dmg : 16000 与 dmg:16000 等价。'
              '分隔符只认 : @ #，因为 buff id 只允许字母数字下划线，永远不会冲突。'),
        ('h2', '6. 效果格示例'),
        ('table', (
            ['写法', '含义'],
            [
                ['dmg', '一次伤害，倍率用 buff 表里 dmg 的默认值'],
                ['dmg:24000', '2.4 倍攻击的伤害'],
                ['burn', '挂灼烧'],
                ['slow@4000', '40% 概率挂减速'],
                ['dmg:30000#2', '3 倍伤害，叠 2 层'],
                ['knockup', '击飞'],
            ],
            [2, 4],
        )),
        ('p', '一段要同时打「伤害 + 灼烧」，就把 dmg 填 e1、burn 填 e2，'
              '不要试图在同一个格里写两个 buff。'),
        ('h2', '7. 硬规则（违反会告警或失效）'),
        ('table', (
            ['规则', '违反后果'],
            [
                ['同一技能内 charId + slot + hit 必须唯一', '导出报错拦住（重复 = 同一时刻结算两次 = 双倍伤害）'],
                ['效果格必须从 e1 开始连续填', '告警“效果格不连续”，仍按已填的格结算（不丢数据）'],
                ['每段最多 4 组效果', 'e5 及以后不存在，多写的内容不会被读取'],
                ['buff id 必须在 buff 表存在', '报错拦住，该格无法导出'],
                ['charId + slot 必须在 skill 表有对应技能', '报错拦住（孤儿打击点，运行时整组忽略）'],
                ['每段至少有一个有效效果', '告警，该段不结算'],
            ],
            [2, 4],
        )),
        ('h2', '8. 新增一个技能的步骤'),
        ('p', '① skill 表加一行（charId + slot + anim + duration）→ '
              '② hit 表按同一 charId + slot 加 1~N 行打击点 → '
              '③ 需要全新效果就去 buff 表加一行（再在 hit 里引用它的 id）→ '
              '④ 跑起来看日志「打击点 x.xxs」，对照动画把 at 调准。'),
    ],

    'battle': [
        ('h2', '2. 这张表怎么组织'),
        ('p', '它不是行式表：每种全局参数就是一行，第 4 列「值」写实际数值，'
              '导出时组装成一个扁平对象写进 battle.json。'),
        ('p', '键名不可改（代码按名字读）；要加新参数得先在 schema.py 里登记，'
              '再重跑 gen-templates.py --force。'),
        ('h2', '3. 数组怎么写'),
        ('p', 'speedOptions 是数组，在「值」列里用逗号分隔写万分比：5000,10000,20000,30000'
              '（即 0.5 / 1 / 2 / 3 倍速）。导出时会切成数字数组。'),
        ('h2', '4. 常见错误对照'),
        ('table', (
            ['现象', '原因', '修法'],
            [
                ['倍速按钮消失', 'speedOptions 写成空或格式不对', '写成 5000,10000,20000,30000'],
                ['开场角色重叠', 'spawnDistance 太小', '调到 ≥ 两人射程之和'],
                ['技能没伤害', 'skillTargetTime 与动画时长差太多', '对齐 skill 表的 duration'],
                ['所有时间类参数都不生效', '忘了乘 10000，把 2.5 秒填成了 2', '时间类填毫秒×10：2.5 秒 → 25000'],
            ],
            [2, 2, 2],
        )),
    ],
}


def rules_for(table):
    intro = {
        'character': ['一行 = 一个角色。id 是主键，整条配置链的起点。'],
        'spine': ['一行 = 一个角色的骨骼资源与显示参数。id 与 character 表一一对应。'],
        'anim': ['一行 = 一个动画引用。同一角色的 idle / run / hurt / attack 各占一行。'],
        'buff': ['一行 = 一种效果的定义。hit 表的效果格按 id 引用它。'],
        'skill': ['一行 = 一个技能。charId + slot 唯一。战斗界面按钮按本表里该角色的行顺序'
                  '从左到右排，slot 只是技能编号（决定日志与内部 id skillN）。',
                  '本表只负责「谁、用哪个动画、演多久、多少蓝、多少冷却」。'],
        'hit': ['一行 = 一个打击点。'],
    }[table]
    blocks = base_rules(table, intro)
    blocks += EXTRAS[table]
    blocks += SYNC_BLOCKS
    return blocks


def rules_for_kv(table):
    spec = schema.KV_TABLES[table]
    body = [[k[0], doc_type(k[1]), k[3] or k[2]] for k in spec['keys']]
    blocks = [
        ('title', f'{spec["sheet"]} · 配置规则（对应 assets/resources/config/{table}.json）'),
        ('p', f'Sheet「{spec["sheet"]}」是数据，本页是规则。'),
        ('note', WF_NOTE),
        ('note', MS_NOTE),
        ('h2', '1. 这张表是什么'),
        ('p', spec['doc']),
        ('table', (['键名', '类型', '说明'], body, [2, 1, 3])),
    ]
    blocks += EXTRAS[table]
    blocks += SYNC_BLOCKS
    return blocks


# =====================================================================
# 生成
# =====================================================================

# 列宽只管排版，不参与结构；结构（字段名/类型/备注/必填）在 schema.py
WIDTHS = {
    'character': {'id': 13, 'name': 11, 'maxHp': 9, 'atk': 8, 'def': 8,
                  'critRate': 12, 'attackRange': 11, 'moveSpeed': 11, 'accent': 10},
    'spine': {'id': 13, 'bundle': 10, 'path': 28, 'scale': 11, 'anchorX': 9,
              'anchorY': 9, 'headY': 8, 'flip': 10, 'offsetX': 9, 'offsetY': 9},
    'anim': {'charId': 13, 'kind': 9, 'anim': 18, 'duration': 12, 'order': 9},
    'buff': {'id': 13, 'name': 13, 'buffType': 11, 'target': 9, 'duration': 11,
             'tick': 11, 'value': 10, 'valueType': 13, 'sign': 9, 'stats': 44,
             'control': 9, 'distance': 9, 'height': 9, 'moveTime': 11,
             'stackMax': 9, 'stackMode': 9, 'color': 9, 'shake': 10},
    'skill': {'charId': 13, 'slot': 8, 'name': 13, 'short': 9, 'anim': 14,
              'duration': 12, 'energyCost': 11, 'cooldown': 12, 'lunge': 9,
              'range': 8, 'color': 10},
    'hit': {'charId': 13, 'slot': 7, 'hit': 6, 'at': 10, 'shake': 10,
            'e1': 22, 'e2': 22, 'e3': 22, 'e4': 22},
    'battle': {'键名': 22, '类型': 14, '说明': 56, '值': 24},
}


def build_xlsx(path, table, rows):
    spec = schema.TABLES[table]
    wb = Workbook()
    ws = wb.active
    ws.title = spec['sheet']
    write_data_sheet(ws, spec['cols'], WIDTHS[table], rows)
    rs = wb.create_sheet('配置规则')
    write_rules_sheet(rs, rules_for(table))
    wb.save(path)
    return os.path.getsize(path)


def build_kv_xlsx(path, table, data):
    spec = schema.KV_TABLES[table]
    wb = Workbook()
    ws = wb.active
    ws.title = spec['sheet']
    write_kv_sheet(ws, spec['keys'], WIDTHS[table], data)
    rs = wb.create_sheet('配置规则')
    write_rules_sheet(rs, rules_for_kv(table))
    wb.save(path)
    return os.path.getsize(path)


def _fix_wf_rec(table, rec):
    """旧版表里 wf / ms 列可能是小数（0.45 / 1.7），重建时转成整数（4500 / 1700）。

    只在「本来就是小数」时才乘，避免把已经改成整数的 4500 再乘一次。
    """
    for f in schema.wf_cols(table):
        v = rec.get(f)
        if isinstance(v, float) and not v.is_integer():
            rec[f] = int(round(v * 10000))
    for f in schema.ms_cols(table):
        v = rec.get(f)
        if isinstance(v, float) and not v.is_integer():
            rec[f] = int(round(v * 1000))
    for f, keys in schema.OBJ_WF_KEYS.get(table, {}).items():
        v = rec.get(f)
        if isinstance(v, str) and v.strip().startswith('{'):
            try:
                obj = json.loads(v)
            except Exception:
                continue
            for k in keys:
                if isinstance(obj.get(k), float) and not obj[k].is_integer():
                    obj[k] = int(round(obj[k] * 10000))
            rec[f] = json.dumps(obj, ensure_ascii=False)
    return rec


def salvage_rows(path, table):
    """--force 重建时，把旧表里已录入的数据按字段名捞出来，尽量不丢人工修改。

    返回 list[dict] 或 None（认不出结构时退回从 JSON 重建）。
    """
    if not os.path.exists(path):
        return None
    expect = set(schema.col_names(table))
    try:
        wb = load_workbook(path, data_only=True)
    except Exception:
        return None

    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < DATA_START - 1:
        return None

    header = [str(c).strip() if c is not None else '' for c in rows[NAME_ROW - 1]]
    known = [h for h in header if h in expect]
    # 认得出的列不到一半，说明不是本脚本生成的三行表头格式，别硬捞
    if not known or len(known) * 2 < len(expect):
        return None

    out = []
    for r in rows[DATA_START - 1:]:
        rec = {}
        for i, name in enumerate(header):
            if name in expect and i < len(r) and r[i] is not None and str(r[i]).strip() != '':
                rec[name] = r[i]
        if rec:
            out.append(_fix_wf_rec(table, rec))
    return out


def salvage_kv(path, table):
    if not os.path.exists(path):
        return None
    expect = set(schema.kv_names(table))
    try:
        wb = load_workbook(path, data_only=True)
    except Exception:
        return None
    ws = wb[wb.sheetnames[0]]
    out = {}
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if not r or r[0] is None:
            continue
        name = str(r[0]).strip()
        if name in expect and len(r) > 3 and r[3] is not None and str(r[3]).strip() != '':
            out[name] = r[3]
    return out or None


def load_json(name):
    """建模板时的初值来源：优先用 config-templates/json 里的导出产物，
    没有才退回客户端侧那份。"""
    for p in (os.path.join(OUT, 'json', f'{name}.json'),
              os.path.join(CFG, f'{name}.json')):
        if os.path.exists(p):
            with io.open(p, encoding='utf-8') as f:
                return json.load(f)
    return {}


# =====================================================================
# ConfigTypes.ts 生成
# =====================================================================

TYPES_PATH = os.path.join(ROOT, 'assets', 'scripts', 'fight', 'ConfigTypes.ts')

TYPES_HEADER = '''/**
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
'''


def build_config_types(path):
    """按 schema 生成 ConfigTypes.ts 全文。返回字节数。"""
    lines = [TYPES_HEADER]

    for name, ts, doc in schema.TYPE_ALIASES:
        lines.append(f'/** {doc} */')
        lines.append(f'export type {name} = {ts};')
        lines.append('')

    for table in schema.row_tables():
        spec = schema.TABLES[table]
        lines.append(f'/** {spec["doc"]} */')
        lines.append(f'export interface {spec["cls"]} {{')
        for c in spec['cols']:
            remark = schema.col_remark(c)
            long = schema.col_long(c)
            if long:
                lines.append('    /**')
                lines.append(f'     * {remark}')
                lines.append(f'     * {long}')
                lines.append('     */')
            else:
                lines.append(f'    /** {remark} */')
            mark = '' if schema.col_required(c) else '?'
            lines.append(f'    {schema.col_name(c)}{mark}: {schema.ts_type(schema.col_type(c))};')
        lines.append('}')
        lines.append('')

    text = '\n'.join(lines).rstrip() + '\n'
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return len(text.encode('utf-8'))


# =====================================================================
# 自检
# =====================================================================

def check_hits(hit_rows):
    errors = []
    for r in hit_rows:
        for i in (1, 2, 3, 4):
            if i > 1 and r.get(f'e{i}') and not r.get(f'e{i-1}'):
                errors.append(f"{r['charId']}#{r['slot']} 第{r['hit']}段 e{i} 前面的格子是空的")

    # 段号唯一：重复 = 同一时刻结算两次 = 双倍伤害，运行时零报错
    segs = {}
    for r in hit_rows:
        hit_no = r.get('hit')
        if hit_no is None:
            continue
        key = (r['charId'], r['slot'], hit_no)
        if key in segs:
            errors.append(f"{r['charId']} 槽{r['slot']} 段号 {hit_no} 重复"
                          f"（两段会同时结算）")
        else:
            segs[key] = r
    return errors


GAME_CONFIG_TS = os.path.join(ROOT, 'assets', 'scripts', 'fight', 'GameConfig.ts')


def check_ms_consistency(ts_path=GAME_CONFIG_TS):
    """schema 登记的毫秒字段 == GameConfig.ts 里真正 ÷1000 的字段。

    时间字段两处脱节的后果比万分比更隐蔽：
      · schema 标了 ms、代码没除 → 1.7 秒的技能被当成 1700 秒，动作播一年
      · 代码除了 1000、schema 没标 → 填 1700 期望 1.7 秒，实际 1700 秒
    所以这段检查与万分比那段同等对待。
    """
    errors = []
    if not os.path.exists(ts_path):
        return [f'找不到 {ts_path}，无法校验毫秒清单']

    src = io.open(ts_path, encoding='utf-8').read()

    # 代码侧：ms(xxx.field, ...)。注意排除毫秒转秒以外的同名调用。
    code_fields = set(re.findall(
        r'\bms\s*\(\s*[A-Za-z_$][\w$]*\??\.([A-Za-z_$][\w$]*)', src))
    # schema 侧：排除 battle（它走 BATTLE_MS_KEYS 白名单，单独比）
    schema_fields = {f for (t, f) in schema.all_ms_fields() if t != 'battle'}

    for f in sorted(schema_fields - code_fields):
        errors.append(f'schema 把 "{f}" 标成了毫秒，但 GameConfig.ts 里没有 ms(...{f}) 读取')
    for f in sorted(code_fields - schema_fields):
        errors.append(f'GameConfig.ts 里对 "{f}" 用了 ms()，但 schema 没标成毫秒')

    def _set_of(name):
        m = re.search(name + r'\s*=\s*new Set<string>\(\[(.*?)\]\)', src, re.S)
        return set(re.findall(r"'([A-Za-z_$][\w$]*)'", m.group(1))) if m else None

    got = _set_of('BATTLE_MS_KEYS')
    expect = schema.kv_ms('battle')
    if got is None:
        errors.append('GameConfig.ts 里找不到 BATTLE_MS_KEYS')
    else:
        for k in sorted(expect - got):
            errors.append(f'battle 毫秒键：schema 有 "{k}"，BATTLE_MS_KEYS 里没有（会少除一次 1000）')
        for k in sorted(got - expect):
            errors.append(f'battle 毫秒键：BATTLE_MS_KEYS 有 "{k}"，schema 没标（会多除一次 1000）')
    return errors


def check_wf_consistency(ts_path=GAME_CONFIG_TS):
    """schema 登记的万分比字段 == GameConfig.ts 里真正 ÷10000 的字段。

    两处脱节的后果是 10000 倍误差且完全不报错：
      · schema 标了 wf、代码没除 → 数值被当成整数字面量用（血量 880 变成 880 万）
      · 代码除了 10000、schema 没标 → 配表的人看到「类型 int」就填整数，
        运行时被多除一次，变成 0.088
    所以这段检查必须过，才能重建模板。
    """
    errors = []
    if not os.path.exists(ts_path):
        return [f'找不到 {ts_path}，无法校验万分比清单']

    src = io.open(ts_path, encoding='utf-8').read()

    # 代码侧：wf(xxx.field, ...) / wfArray(xxx.field)
    code_fields = set(re.findall(
        r'\bwf(?:Array)?\s*\(\s*[A-Za-z_$][\w$]*\??\.([A-Za-z_$][\w$]*)', src))
    # schema 侧：排除 battle（它走 BATTLE_WF_KEYS 白名单，单独比）
    schema_fields = {f for (t, f) in schema.all_wf_fields() if t != 'battle'}

    for f in sorted(schema_fields - code_fields):
        errors.append(f'schema 把 "{f}" 标成了万分比，但 GameConfig.ts 里没有 wf(...{f}) 读取')
    for f in sorted(code_fields - schema_fields):
        errors.append(f'GameConfig.ts 里对 "{f}" 用了 wf()，但 schema 没标成万分比')

    def _set_of(name):
        m = re.search(name + r'\s*=\s*new Set<string>\(\[(.*?)\]\)', src, re.S)
        return set(re.findall(r"'([A-Za-z_$][\w$]*)'", m.group(1))) if m else None

    for const, expect, label in (
        ('BATTLE_WF_KEYS', schema.kv_wf('battle'), 'battle 万分比键'),
        ('BATTLE_WF_ARRAYS', schema.kv_list_wf('battle'), 'battle 万分比数组键'),
    ):
        got = _set_of(const)
        if got is None:
            errors.append(f'GameConfig.ts 里找不到 {const}')
            continue
        for k in sorted(expect - got):
            errors.append(f'{label}：schema 有 "{k}"，{const} 里没有（会少除一次 10000）')
        for k in sorted(got - expect):
            errors.append(f'{label}：{const} 有 "{k}"，schema 没标（会多除一次 10000）')
    return errors


def check_wf_values():
    """JSON 里的万分比字段必须是整数。出现小数说明迁移漏了或有人手改成了小数。"""
    errors = []

    def bad(table, where, field, v):
        errors.append(f'{table}.{field} 在 {where} 是小数 {v}，应为万分比整数'
                      f'（{v} × 10000 = {int(round(v * 10000))}）')

    for table in schema.row_tables():
        wf_cols = schema.wf_cols(table)
        obj_cols = schema.OBJ_WF_KEYS.get(table, {})
        for r in load_json(table).get('rows', []):
            where = r.get('charId') or r.get('id') or '(无标识行)'
            for f in wf_cols:
                if isinstance(r.get(f), float):
                    bad(table, where, f, r[f])
            for f, keys in obj_cols.items():
                o = r.get(f)
                if isinstance(o, dict):
                    for k in keys:
                        if isinstance(o.get(k), float):
                            bad(table, where, f'{f}.{k}', o[k])

    for table in schema.kv_tables():
        data = load_json(table)
        for k in schema.kv_wf(table):
            if isinstance(data.get(k), float):
                bad(table, '(键值)', k, data[k])
        for k in schema.kv_list_wf(table):
            arr = data.get(k)
            if isinstance(arr, list):
                for x in arr:
                    if isinstance(x, float):
                        bad(table, '(数组项)', k, x)
    return errors


def check_ms_values():
    """JSON 里的毫秒字段必须是整数毫秒。出现小数说明单位迁移漏了或有人改成秒了。"""
    errors = []

    def bad(table, where, field, v):
        errors.append(f'{table}.{field} 在 {where} 是小数 {v}，应为整数毫秒'
                      f'（{v} 秒 → 填 {int(round(v * 1000))}）')

    for table in schema.row_tables():
        ms_cols = schema.ms_cols(table)
        for r in load_json(table).get('rows', []):
            where = r.get('charId') or r.get('id') or '(无标识行)'
            for f in ms_cols:
                if isinstance(r.get(f), float):
                    bad(table, where, f, r[f])

    for table in schema.kv_tables():
        data = load_json(table)
        for k in schema.kv_ms(table):
            if isinstance(data.get(k), float):
                bad(table, '(键值)', k, data[k])
    return errors


def main():
    ap = argparse.ArgumentParser(description='生成配表模板与 TS 类型（xlsx 已存在时默认跳过）')
    ap.add_argument('--force', action='store_true',
                    help='重建全部 xlsx。会先按字段名把旧表数据捞出来，但仍建议先导出一遍 JSON')
    ap.add_argument('--only', help='只重建其中一张表')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    if not args.force:
        print('只生成还不存在的 xlsx，已存在的会跳过（不会冲掉你录入的数据）。')
        print('确实要按 schema 重建全部模板：加 --force')
        print('')
    targets = [args.only] if args.only else schema.row_tables()
    kv_targets = [args.only] if args.only else schema.kv_tables()

    for table in targets:
        if table not in schema.TABLES:
            print(f'✖ 没有这张表：{table}（可用：{", ".join(schema.row_tables())}）', file=sys.stderr)
            return 2
    for table in kv_targets:
        if table not in schema.KV_TABLES:
            print(f'✖ 没有这张键值表：{table}（可用：{", ".join(schema.kv_tables())}）', file=sys.stderr)
            return 2

    skipped = []

    for table in schema.row_tables():
        if table not in targets:
            continue
        path = os.path.join(OUT, f'{table}.xlsx')
        if os.path.exists(path) and not args.force:
            skipped.append(table)
            continue

        json_rows = load_json(table).get('rows', [])
        rows, note = json_rows, '来自 JSON'
        if args.force:
            kept = salvage_rows(path, table)
            if kept is not None:
                rows, note = kept, f'保留旧表 {len(kept)} 行'

        size = build_xlsx(path, table, rows)
        print(f'{table + ".xlsx":<16}{size:>7,} B   {len(rows)} 行   {note}')

    for table in schema.kv_tables():
        if table not in kv_targets:
            continue
        path = os.path.join(OUT, f'{table}.xlsx')
        if os.path.exists(path) and not args.force:
            skipped.append(table)
            continue

        data = load_json(table)
        note = '来自 JSON'
        if args.force:
            kept = salvage_kv(path, table)
            if kept is not None:
                data, note = kept, f'保留旧表 {len(kept)} 个参数'

        size = build_kv_xlsx(path, table, data)
        print(f'{table + ".xlsx":<16}{size:>7,} B   {len(data)} 项   {note}')

    ts_size = build_config_types(TYPES_PATH)
    print(f'{"ConfigTypes.ts":<16}{ts_size:>7,} B   {len(schema.row_tables())} 个接口')

    if skipped:
        print(f'\n跳过已存在的模板：{", ".join(skipped)}')
        print('（xlsx 是配置真源，不覆盖。要重建加 --force）')

    errors = []
    errors += [f'打击点：{e}' for e in check_hits(load_json('hit').get('rows', []))]
    errors += [f'万分比清单：{e}' for e in check_wf_consistency()]
    errors += [f'毫秒清单：{e}' for e in check_ms_consistency()]
    errors += [f'万分比取值：{e}' for e in check_wf_values()]
    errors += [f'毫秒取值：{e}' for e in check_ms_values()]

    if errors:
        print('\n✖ 自检失败：')
        for e in errors:
            print('  -', e)
        return 1

    print('\n自检通过：打击点效果格连续、段号唯一；'
          '万分比 / 毫秒清单与 GameConfig 一致；JSON 里没有小数')
    print('\n下一步：编辑 config-templates/*.xlsx → 双击「导出配置.bat」→ '
          '双击 tools/导入客户端.bat')
    return 0


if __name__ == '__main__':
    sys.exit(main())
