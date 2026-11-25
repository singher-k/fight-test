# 经验库 · cocos-client-engineer

> 只记增量：专家包 §10 踩坑库已覆盖的不重复。每条注明验证方式，未验证的推测不记。

### 2026-11-25｜Windows bat 里写中文 echo 会被 cmd 按代码页误解码，导致命令行断裂
- 症状/场景：`导出配置.bat` 里一行 `echo 确实要按 schema 重建： 生成模板.bat --force`，运行时报
  `'ma' is not recognized as an internal or external command` —— 中文字节被当 GBK 解码后字节错位，
  把 `schema` 的 `sche` 吃进乱码、剩下的 `ma` 当了命令执行。**文件头的 `chcp 65001` 不能可靠地
  拯救同一文件后续行的中文**（同一文件前半段中文 echo 还显示正常，后半段就炸了）。
- 方案：定规「**bat 只写 ASCII，所有中文提示交给 Python 输出**」。py 的 `print` 走 stdout 本就是
  UTF-8，`chcp 65001` 下显示正常。加一条断言 `b.isascii()` 作为文件级门禁。
  附带：`if not defined X cmd && set ...` 单行组合会被 cmd 报「此时不应有 &&」，改用括号块 +
  `if not errorlevel 1 set`；bat 必须 CRLF 行尾（LF 下括号块解析不稳）。
- 验证结果：三个 bat（生成模板 / 导出配置 / 导入客户端）在 `echo | cmd //c` 下实测跑通，
  中文输出零乱码、`'ma'` 报错消失；三文件 `isascii()` 断言通过。

### 2026-11-25｜配置工具拆「导出→验收→导入」两段，且产物 diff 必须按主键对齐
- 症状/场景：①导出直接写 `assets/resources/config/`，配错了只能靠 git 回滚，且 Cocos 会立刻读到
  半成品。②差异报告按**行索引**对比，用户往 hit 表中间插 13 行后，输出变成一片
  `charId: 'H30027' → 'E200004'`、`slot: 1 → 2`，看着像全表配坏，实际只是挪了行。
- 方案：①导出落中间目录 `config-templates/json/`，再由独立 `tools/import-config.py` 推进
  `assets/`——验收不过就停在第一步。导入侧做「语法 + 顶层结构 + 必填字段 + 键值键集」校验，
  全部通过才动盘；覆盖前备份、写 `.tmp` 再 `os.replace`、只覆盖不删、`.meta` 不碰。
  ②`diff_rows` 改按主键对齐（`id` / `charId+kind` / `charId+slot` / `charId+slot+hit`），
  主键不全的行退回索引；输出改成「新增 13 / 删除 3 / 修改 1」+ 逐行键文本 `E200004·2·3`。
  ③导出基线读取加回退：中间目录缺表时以客户端现有 JSON 为基线，否则首轮会报「整表新增 + 外键
  全断」；顺手加 `~$xxx.xlsx` 锁文件检测，抓「Excel 开着没保存就导出」。
- 验证结果：临时目录跑全链路——导出 7 表 → 导入 7 表 → 二次导入「全部一致」（幂等）→
  `diff -r` 逐字节相同；真实目录跑过一次，7 表写入 + 时间戳备份齐全，验完快照还原。
  `gen-templates.bat` 幂等：`ConfigTypes.ts` md5 前后一致，7 张 xlsx 全部跳过。

### 2026-11-25｜探测外部解释器必须验「主版本号」，只验「能启动」会把 Python 2 当合格
- 症状/场景：bat 里用 `python -c "import sys"` 探测，成功就认定可用。结果用户机器 PATH 上
  第一个 `python` 是 `C:/Python27/python.exe`（Python 2.7.18），探测通过 → 走进 2.7 的 pip →
  在 `chcp 65001` 下崩：`LookupError: unknown encoding: cp65001`（pip 内部拿 `sys.stdout.encoding`
  = cp65001 去 `codecs.lookup`）。更迷惑的是同一台机器在 Git Bash 里跑得好好的——因为 Git Bash
  的 PATH 里排在前面的是 WorkBuddy 内置的 Python 3.13，**两套环境的解释器解析结果不同**。
- 方案：探测串改成 `python -c "import sys;sys.exit(0 if sys.version_info[0]==3 else 1)"`，按
  `python` → `py -3` → `python3` → 常见安装根目录（`%LOCALAPPDATA%\Programs\Python\Python3*`、
  `C:/Program Files\Python3*`、工具链自带版本目录）逐个试，取第一个真正 3.x 的。
  抽公共 `tools/_find-python.bat` 供三个 bat `call`，**子脚本不能 `setlocal`**（会丢掉导出的
  `PYEXE`）。pip 安装前后临时 `chcp 936` / `chcp 65001` 兜底老版本 pip 的 cp65001 缺陷。
  窗口打印 `Using: <解释器路径>`，让「选错了」这件事一眼可见。
- 验证结果：用 `set "PATH=C:/Python27;C:/Windows/system32;C:/Windows"` 的临时 bat 模拟用户环境
  （`where python` 确认指向 2.7.18），三个 bat 全部自动兜底到内置 Python 3.13 并跑通，
  中文输出零乱码。教训：**跨环境（IDE 终端 / 双击 cmd）行为不一致时，先查 `where` / `which -a`，
  别信「我这边能跑」**。

### 2026-11-25｜时间字段不要用万分比：`17000` 到底是 1.7 秒还是 17000 毫秒
- 症状/场景：上一轮「全配置去小数」把所有小数统一乘 10000，连时间字段一起改成了万分比
  （`skill.duration = 1.7 → 17000`）。结果配表的人看到 17000，理解成「17 秒 / 17000 毫秒」，
  在 `hit.at` 里按毫秒填了 5500 / 10500 / … / 23300。而 `at` 当时是「动作进度万分比」，
  校验区间写死 200~9800：5500 恰好落进区间被放过，只报了 12 条，看着像「只有后半段有问题」，
  实际 14 段全部越界；运行时 `clamp(0.02, 0.98)` 把它们全压到 0.98，一次出手 14 段同帧结算。
- 方案：**比例/倍数用万分比（wf），时间用整数毫秒（ms）**，两套白名单互不混用。
  schema 新增 `MS` 类型与 `ms_cols/all_ms_fields`；GameConfig 加 `ms()`（÷1000），
  `BATTLE_WF_KEYS` 只留 6 个比例键、新增 `BATTLE_MS_KEYS` 8 个时间键；
  `hit.at` 的校验从「固定 200~9800」改成「不得超过本技能演出时长」
  （`skill.duration`，为 0 时按 `battle.skillTargetTime`，与 Fighter 的兜底同口径）。
  另加**单位守卫**：导出时校验 xlsx 第 1 行备注 / 键值表说明列必须含「毫秒」或「万分比」，
  schema 改了单位而 xlsx 没同步时直接中止——否则数值整体差 10 倍、导出却「成功」。
- 验证结果：214 个时间值「新毫秒 ÷1000 == 旧万分比 ÷10000」逐项相等；把 fight 目录编译成
  CommonJS + `cc` 桩，用**真实 GameConfig** 解析新 JSON，39 个 duration/cooldown 与 77 个
  `at`（0.35 / 0.55 / 0.75 这类）与旧口径逐位一致；负向 4 项：at 填 1.7 被拦（提示「1.7 → 1700」）、
  旧单位模板被拦、`BATTLE_MS_KEYS` 漏键/多键被门禁抓住。
- ★ 附带教训：万分比迁移这类批量改语义的操作，**必须区分「比例」和「量纲」**——
  比例适合整数化，量纲（时间/像素/角度）整数化只会制造歧义。
