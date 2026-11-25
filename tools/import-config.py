#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把导出的配置推给客户端。

    config-templates/json/*.json  →  assets/resources/config/*.json

★ 为什么分两步：导出（config-templates/导出配置.bat）只负责把 xlsx 变成 JSON，
  产物先落在 config-templates/json/ 供你验收；本脚本才把验收过的 JSON 推到
  Cocos 真正读取的 assets/resources/config/。看错了就在第一步停住，客户端不受影响。

用法（推荐双击 tools/导入客户端.bat）：
    python tools/import-config.py            # 对比 + 导入
    python tools/import-config.py --check    # 只对比，不写盘

安全策略：
    - 导入前逐张校验 JSON 语法与顶层结构，任何一张不过就直接中止，一个文件都不写。
    - 目标已有内容不同的文件先备份到 tools/.backup/<时间戳>/。
    - 原子写：先写 .tmp 再 rename，避免中途失败留下半个 JSON。
    - 只覆盖、不删除：assets 里有但 json/ 里没有的表只提示，不会自动删。
    - .meta 一律不动，只覆盖 .json 本体。
"""

import argparse
import io
import json
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL_DIR = os.path.join(ROOT, 'config-templates')
SRC_DEFAULT = os.path.join(TPL_DIR, 'json')
DST_DEFAULT = os.path.join(ROOT, 'assets', 'resources', 'config')
BACKUP_ROOT = os.path.join(ROOT, 'tools', '.backup')

sys.path.insert(0, TPL_DIR)
try:
    import schema  # noqa: E402  表清单/字段名唯一来源
except Exception as e:  # pragma: no cover
    print(f'✖ 无法读取 config-templates/schema.py：{e}')
    sys.exit(1)

ROW_TABLES = schema.row_tables()   # character / spine / anim / buff / skill / hit
KV_TABLES = schema.kv_tables()     # battle
ALL_TABLES = ROW_TABLES + [t for t in KV_TABLES if t not in ROW_TABLES]


def rel(p):
    return os.path.relpath(p, ROOT).replace(os.sep, '/')


def validate_row_table(name, doc, warns):
    """行式表结构校验 + 字段集一致性检查。返回错误文本或 None。"""
    if not isinstance(doc, dict) or 'rows' not in doc:
        return f'{name}.json 顶层应该是 {{"rows": [...]}}'
    rows = doc['rows']
    if not isinstance(rows, list):
        return f'{name}.json 的 rows 不是数组'
    if not rows:
        return f'{name}.json 的 rows 是空的（整表没数据，客户端会读到空配置）'
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            return f'{name}.json 的 rows[{i}] 不是对象'

    # 字段集对账：schema 加了必填列却没重新导出、或旧字段没清掉，都会在这里露出来。
    # 只查「必填缺失」和「多出的字段」——可选字段全表为空时导出会整列省略，那是正常的。
    try:
        cols = set(schema.col_names(name))
        need = set(schema.required(name))
    except Exception:
        return None
    got = set()
    for r in rows:
        got |= set(r.keys())
    missing = sorted(need - got)
    extra = sorted(got - cols)
    if missing:
        warns.append(f'{name}.json 缺必填字段 {missing} —— schema 加过列？'
                     f'重新导出一遍（导出配置.bat）')
    if extra:
        warns.append(f'{name}.json 有 schema 里已不存在的字段 {extra} —— '
                     f'旧字段残留，重新导出一遍即可清掉')
    return None


def validate_kv_table(name, doc):
    if not isinstance(doc, dict):
        return f'{name}.json 顶层应该是对象 {{"键": 值}}'
    if not doc:
        return f'{name}.json 是空的（没有键值参数）'
    bad = [k for k, v in doc.items()
           if not isinstance(v, (int, float, str, bool, list, dict))]
    if bad:
        return f'{name}.json 里 {bad} 的值类型不认识'
    try:
        want = set(schema.kv_names(name))
    except Exception:
        return None
    missing = sorted(want - set(doc))
    extra = sorted(set(doc) - want)
    if missing:
        return f'{name}.json 缺参数 {missing}（schema 里定义了但 JSON 没有）'
    if extra:
        return f'{name}.json 有 schema 里已不存在的参数 {extra}'
    return None


def main():
    ap = argparse.ArgumentParser(description='把 config-templates/json 导入客户端')
    ap.add_argument('--src', default=SRC_DEFAULT, help='导出的 JSON 目录')
    ap.add_argument('--dst', default=DST_DEFAULT, help='客户端资源目录')
    ap.add_argument('--check', action='store_true', help='只对比，不写盘')
    ap.add_argument('--quiet', action='store_true', help='只打印结论')
    args = ap.parse_args()

    print('=' * 66)
    print(f'源目录  {rel(args.src)}')
    print(f'目标    {rel(args.dst)}')
    print('=' * 66)

    if not os.path.isdir(args.src):
        print(f'✖ 找不到导出目录 {rel(args.src)}')
        print('  先双击 config-templates/导出配置.bat 生成 JSON。')
        return 1

    missing_src = [t for t in ALL_TABLES
                   if not os.path.exists(os.path.join(args.src, f'{t}.json'))]
    if missing_src:
        print(f'✖ 导出目录里缺少 {missing_src} 的 JSON，已中止（未写入任何文件）')
        print('  先双击 config-templates/导出配置.bat 完整导出一遍。')
        return 1

    # ---- 先把所有文件读进内存并校验，全部通过才动目标目录 ----
    errors, warns = [], []
    payloads = []
    for t in ALL_TABLES:
        p = os.path.join(args.src, f'{t}.json')
        try:
            with io.open(p, 'rb') as f:
                raw = f.read()
            text = raw.decode('utf-8-sig')
            doc = json.loads(text)
        except UnicodeDecodeError:
            errors.append(f'{t}.json 不是 UTF-8 编码')
            continue
        except json.JSONDecodeError as e:
            errors.append(f'{t}.json 语法错误：第 {e.lineno} 行第 {e.colno} 列 {e.msg}')
            continue

        err = (validate_kv_table(t, doc) if t in KV_TABLES
               else validate_row_table(t, doc, warns))
        if err:
            errors.append(err)
            continue

        n = len(doc) if t in KV_TABLES else len(doc['rows'])
        payloads.append((t, text, n, t in KV_TABLES))

    if errors:
        print(f'\n✖ 校验未通过 {len(errors)} 项，已中止，未写入任何文件：')
        for e in errors:
            print('  -', e)
        return 1

    # ---- 对比 ---- 
    os.makedirs(args.dst, exist_ok=True)
    changed, same = [], []
    for t, text, n, _is_kv in payloads:
        dst = os.path.join(args.dst, f'{t}.json')
        old = None
        if os.path.exists(dst):
            with io.open(dst, 'rb') as f:
                old = f.read().decode('utf-8-sig', 'replace')
        (same if old == text else changed).append((t, text, n, _is_kv, dst))

    if not args.quiet:
        for t, _text, n, is_kv, _dst in changed:
            unit = '个参数' if is_kv else '行'
            print(f'  变化  {t}.json（{n} {unit}）')
        for t, _text, n, is_kv, _dst in same:
            unit = '个参数' if is_kv else '行'
            print(f'  一致  {t}.json（{n} {unit}）')

    # 目标目录里多出来的表：可能是历史残留，不动它，只提示
    known = {f'{t}.json' for t in ALL_TABLES}
    extras = sorted(f for f in os.listdir(args.dst)
                    if f.endswith('.json') and f not in known)
    if extras:
        warns.append(f'{rel(args.dst)} 里有导出目录没有的 JSON：{extras} —— '
                     f'已保留不动，确认是废表再手工删')

    if warns:
        print(f'\n⚠ 告警 {len(warns)} 条（不影响导入）：')
        for w in warns:
            print('  -', w)

    if not changed:
        print(f'\n✔ 客户端已是最新，{len(same)} 张表全部一致，无需导入。')
        return 0

    if args.check:
        print(f'\n（对比模式）{len(changed)} 张表有变化，未写入。'
              f'去掉 --check 或直接双击「导入客户端.bat」生效。')
        return 0

    # ---- 备份 + 原子写 ----
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup_dir = os.path.join(BACKUP_ROOT, stamp)
    backed = 0
    for t, _text, _n, _is_kv, dst in changed:
        if os.path.exists(dst):
            os.makedirs(backup_dir, exist_ok=True)
            shutil.copy2(dst, os.path.join(backup_dir, f'{t}.json'))
            backed += 1

    for t, text, _n, _is_kv, dst in changed:
        tmp = dst + '.tmp'
        with io.open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text if text.endswith('\n') else text + '\n')
        os.replace(tmp, dst)

    print(f'\n✔ 已导入 {len(changed)} 张表到 {rel(args.dst)}：'
          f'{", ".join(t for t, *_ in changed)}')
    if backed:
        print(f'  覆盖前的旧文件备份在 {rel(backup_dir)}')
    print('下一步：切回 Cocos 等资源刷新（新增的表会自动生成 .meta），然后重新预览。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
