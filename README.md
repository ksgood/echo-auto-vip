# echo-auto-vip — 自动领会员

EchoMusic 插件：打开 EchoMusic 时自动领取酷狗概念版「每日畅听会员」，支持像原版一样**连续领取后续日期**；每日自动升级「概念会员」；自动完成每日 8 次「看广告领时长」。

## 功能

- **启动自动领取**：EchoMusic 启动并加载登录态后，自动领取畅听会员。
- **连续领取后续日期**：从今天起连续领取"今天 + 未来 N 天"（可设 0–31 天），会员天数逐日叠加。
- **每日升级概念会员**：每天自动提交一次升级（+1 天概念会员）。服务端限制每天只能升一天且自动应用到当天。
- **自动广告领时长**：每天自动完成"看广告任务"——**领取的时长会自动叠加到概念会员有效期**：每次 +3 小时、每日 8 次 = 每天多 +1 天概念会员。配合每日升级，概念会员实际每天 +2 天，追平畅听会员的速度翻倍。
- **智能去重**：本地记录已成功的日期，当天重复启动不会重复请求。
- **插件管理页可设置**：启用开关、连续领取天数、广告时长次数、每日升级开关、启动延迟、通知开关、指定单日日期、立即执行按钮、会员状态查询、最近记录。

## 技术说明

- **领取/会员状态**：通过宿主 `ctx.kugou`（`capabilities.kugouApi`）调用内置酷狗接口，登录态由宿主注入。
- **升级与广告时长**：插件内置酷狗 android 签名（MD5 + 概念版盐值），经 `ctx.net.request`（`capabilities.unrestrictedNetwork`）直连 `gateway.kugou.com`，登录态与设备态运行时从宿主 Pinia 状态读取，不落盘、不外泄。**不修改 EchoMusic 任何文件，App 升级不受影响。**
- 升级接口实测仅接受 `kugouid + ad_type`，无法指定日期；服务端按自身时钟判定"每日一次"，伪装客户端时间戳（clienttime）无效。

| 动作 | 通道 | 酷狗接口 |
| --- | --- | --- |
| 领取畅听会员 | `ctx.kugou.user.claimDayVip(date)` | `/youth/v1/recharge/receive_vip_listen_song`（`receive_day=YYYY-MM-DD`） |
| 升级概念会员 | 直连签名请求 | `/youth/v1/listen_song/upgrade_vip_reward` |
| 广告领时长 | 直连签名请求 | `/youth/v1/ad/play_report`（每次 +3 小时概念会员有效期，每日 8 次 = +1 天） |
| 会员状态 | `ctx.kugou.user.getUserVipDetail()` | `kugouvip.kugou.com/v1/get_union_vip` |

## 安装

把本目录放入 `C:\Users\YTDB\AppData\Roaming\echo-music\plugins\`，重启 EchoMusic，在「设置 → 插件管理」中启用，即可在插件卡片上打开设置页。

## 注意

- 需要先在 EchoMusic 中登录酷狗账号；未登录时会提示"登录已过期"。
- 网络需要能访问酷狗服务器（必要时开启代理/VPN）；网络失败时本轮终止，下次启动自动重试。
- 领取活动由酷狗服务器控制：日期早于今天会被拒绝；当天未满足听歌条件时服务端会拒绝，插件原样提示。
