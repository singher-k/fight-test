# fight-test
战斗模拟器

## 配置怎么改

**改配置走 xlsx，不直接改 JSON。全程双击 bat，不用敲命令。**

```
编辑 config-templates/*.xlsx
        ↓  双击 config-templates/导出配置.bat
config-templates/json/*.json（导出产物，先在这里验收）
        ↓  双击 tools/导入客户端.bat
assets/resources/config/*.json（运行时只读这个）
        ↓
重启预览
```

导出和导入拆成两步：产物先落在 `config-templates/json/`，你扫一眼确认数值没问题，
再推给客户端。导错了就停在第一步，客户端不受影响。

| 双击这个 | 干什么 | 什么时候用 |
|---|---|---|
| `config-templates/生成模板.bat` | schema → xlsx 模板 + `ConfigTypes.ts` | 首次搭表 / 改了 `schema.py` 的列 |
| `config-templates/导出配置.bat` | xlsx → `config-templates/json/` | **日常改完配置就点这个** |
| `tools/导入客户端.bat` | `json/` → `assets/resources/config/` | 验收完产物，推给客户端 |

三个 bat 都会自己找 Python 3、缺 `openpyxl` 自动装、出错停住不关窗口。
想只看差异不写盘：`导出配置.bat --preview`、`导入客户端.bat --check`。

> **环境要求：Python 3**（3.8+）。注意系统装过 Python 2.7 也不会串——bat 会逐个试
> `python` / `py -3` / `python3` / 常见安装目录，**只认 3.x**，因为 Python 2 的 pip 在
> UTF-8 控制台下会崩（`unknown encoding: cp65001`）。窗口第一行 `Using: ...` 打印的就是
> 实际选中的解释器，排查问题先看它。

| 表 | 管什么 |
|---|---|
| `character.xlsx` | 角色战斗数值（血量 / 攻击 / 防御 / 射程 / 移速） |
| `spine.xlsx` | 骨骼资源路径、缩放、锚点、朝向 |
| `anim.xlsx` | idle / run / hurt / attack 的动画名与时长 |
| `buff.xlsx` | 所有效果的定义（伤害 / 灼烧 / 减速 / 控制 / 击退） |
| `skill.xlsx` | 技能：用哪个动画、演多久、多少蓝、多少冷却 |
| `hit.xlsx` | 打击点：什么时候打、打什么（`charId + slot` 关联技能） |
| `battle.xlsx` | 全局参数（默认阵容、普攻节奏、能量、暴击、倍速） |

每张 xlsx 的第二个 sheet「配置规则」写了字段含义、取值范围、常见错误对照，配表前先读一遍。

### 数值一律不填小数：比例用万分比，时间用毫秒

配置表里**没有小数**。按字段语义分两种口径：

| 字段类型 | 填法 | 例子 | 运行时 |
|---|---|---|---|
| 比例 / 倍数（伤害倍率、暴击率、概率、缩放、属性百分比、震屏） | 万分比整数 | `0.45` → `4500`、`1.6 倍` → `16000` | ÷10000 还原成小数 |
| 时间（时长、冷却、结算间隔、位移耗时、**打击时刻 at**） | 整数毫秒 | `1.7 秒` → `1700`、`0.35 秒` → `350` | ÷1000 还原成秒 |

数据页的「类型」列两种都写 `int`（存的确实是整数），备注行分别标 `(万分比)` / `(毫秒)`。
**程序读进来自动还原**，业务代码看到的永远是普通小数和秒，不需要自己再除。
填成 `0.45` / `1.7` 这种小数会被导出工具直接拦下来，并提示应该填多少。

> **时间为什么不用万分比**：`17000` 到底是 1.7 秒还是 17000 毫秒，读的人分不清。
> 已经踩过一次——`hit.at` 按毫秒填了，却按万分比解析，13 段全被钳到动画末尾。

> 哪些字段是哪种口径：`config-templates/schema.py` 里类型标 `wf` / `ms` 的字段。
> 两份清单与 `GameConfig.ts` 里的 `wf()` / `ms()` / `BATTLE_WF_KEYS` / `BATTLE_MS_KEYS`
> 由生成器自检逐项比对，两边不一致会报错。

> **`hit.at` 是「距技能动画开始的毫秒数」**，上限就是本技能的 `skill.duration`
> （填 0 时按 `battle.skillTargetTime`）。超出的段会被钳到动画末尾，
> 多段会挤在同一时刻结算——导出时会逐条告警。

### 常用命令

平时用不上命令，双击 bat 就行。下面是等价的命令行形式和几个实用开关：

```bash
# 只预览差异，不写盘
python config-templates/export-config.py

# 真正写入 config-templates/json/（覆盖前备份到 config-templates/.backup/）
python config-templates/export-config.py --write

# 只导一张表
python config-templates/export-config.py --only hit --write

# 只对比客户端与 json/ 的差异，不导入
python tools/import-config.py --check

# 首次搭建 / 改了 schema.py 的列结构后重建模板
# （xlsx 已存在时默认跳过，不会覆盖你录入的数据；--force 会先按字段名捞回旧数据）
python config-templates/gen-templates.py --force
```

### 差异报告怎么读

导出时会按**主键**对齐比较（`character/buff/spine` 用 `id`，`anim` 用 `charId+kind`，
`skill` 用 `charId+slot`，`hit` 用 `charId+slot+hit`），所以插一行不会让后面全部显示成改动：

```
hit.xlsx → hit.json   65 行   （新增 13 / 删除 3 / 修改 1）
   [E200004·2·1] e1: 'dmg:21000' → 'dmg:2000'
   新增：E200004·2·2、E200004·2·3、……
   删除：E200004·4·1、E200004·4·2、E200004·4·3
```

`错误` 会拦住写入，一个字节都不落；`告警` 只提示（比如 `at` 越界、效果格不连续、
xlsx 正开在 Excel 里没保存）。

### 列结构只有一个来源

`config-templates/schema.py` 同时驱动三样东西：xlsx 表头、`ConfigTypes.ts`、导出校验。
加字段只改这一个文件，然后 `gen-templates.py --force`。

`assets/scripts/fight/ConfigTypes.ts` 是生成产物，**不要手改**。
