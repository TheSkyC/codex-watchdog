---
id: "0001"
title: 通过 app-server 事件恢复瞬时 goal 故障
status: accepted
date: 2026-08-07
recorded: 2026-08-07
supersedes: null
superseded-by: null
tags: [communication, concurrency, codex-app-server, goal-recovery]
aliases: [transient retry breaker, turn interruption recovery]
paths: [src/controller.mjs, src/proxy.mjs, src/policy.mjs, src/launcher.mjs]
---

## Context

Codex `/goal` 在 provider 短暂断连、网关错误或重试耗尽后可能停在 `blocked`，长时间
运行也可能耗尽上下文。watchdog 需要在不修改 Codex 的前提下恢复原 thread，同时避免
过早中断仍能自行恢复的 turn。恢复动作还可能让工具调用再次发生，因此只能依赖明确的
结构化事件，不能根据终端文本猜测当前会话状态。

## Decision

watchdog 在 Codex TUI 和 app-server 之间运行本地 WebSocket 代理，原样转发常规消息，
并根据相同 `threadId` 和 `turnId` 下的错误、goal 和 turn 事件维护进程内状态。

当 Codex 报告瞬时错误且仍在重试时，watchdog 先等待可配置的宽限期。同一 turn 出现
新的 `item/*` 进展就取消中断；没有进展时，重新读取 goal，确认仍为 `active` 后最多
发送一次 `turn/interrupt`。匹配的 turn 结束后，再按退避时间恢复原 goal。终态瞬时
错误只有同时观察到匹配的 `blocked` goal 才进入恢复。

上下文耗尽时，watchdog 先确认 goal 没有被人工停止，再调用 `thread/compact/start`。
收到压缩完成事件后重新读取 goal，只恢复仍可恢复的状态。认证失败、配额限制、人工暂停、
已完成状态和永久 RPC 错误都会停止当前恢复链。

## Rejected

- 第一次出现 502、503 或连接错误就立即中断。这样延迟更低，但会打断 Codex 本来可以
  自行完成的重试，也更容易重复工具副作用。
- 反复发送 `thread/goal/set active`，不处理中间 turn。活跃请求不会因此释放，新的请求
  还可能排在原请求后面。
- 通过 PTY 自动输入继续命令。终端文本不能可靠提供 `threadId`、`turnId` 和结构化错误
  分类，也无法判断人工暂停与自动故障。
- 修改或固定某个 Codex 版本。这样会把 watchdog 变成 Codex 分叉的维护者，失去外部
  启动器可以独立升级和回退的边界。

## Consequences

普通 Codex 参数和消息保持原样，watchdog 只在满足关联条件时注入少量恢复 RPC。它能
降低瞬时故障导致 goal 停止的概率，但不能保证工具操作恰好执行一次，也不能跨 watchdog
进程保存恢复状态。项目依赖实验性 app-server 协议；Codex 升级后需要重新验证方法、
参数和通知结构。

## Acceptance Evidence - 2026-08-07

- Evidence: npm test 61/61 passed; npm run check passed; npm run test:live passed against Codex CLI 0.146.1; node bin/codex-watchdog.mjs --version exited successfully

## Amendment - 2026-08-07 - 补齐 429 限流恢复与新 turn 竞态保护

- Evidence: npm test 通过 62/62；npm run test:cli、npm run test:live、npm run check 均退出 0
- Consequence: 重试耗尽的 429 会恢复，额度耗尽仍终止；goal 查询或 compact 恢复期间出现新 turn 时取消旧恢复
- Reason decision still stands: 这是既有瞬时故障恢复决策的错误分类与并发正确性补强，不改变 app-server 代理架构

## Amendment - 2026-08-07 - 明确结构化 429 与额度耗尽文本的分类优先级

- Evidence: 新增组合回归测试先稳定失败；调整顺序后 npm test 通过 63/63，npm run test:live 与 npm run check 均退出 0
- Consequence: 明确的 insufficient_quota、quota exhausted 等永久错误优先于结构化 HTTP 429，不会触发自动恢复
- Reason decision still stands: 同一 provider 通知可能同时携带 HTTP 状态和业务错误文本，永久额度语义比通用限流状态更具体

## Amendment - 2026-08-12 - 普通模式在本地 app-server 断线后保留 TUI transport

- Decision: 普通 launcher 在 app-server 异常退出后使用原监听地址持续重启子进程。proxy
  保留 TUI WebSocket，按封顶退避连接替换后的 app-server，并只重放 `initialize` 与
  `initialized` 握手。已经发送过的业务 RPC 不重放，session 选择和 `resume` 仍由 Codex
  负责。
- Rejected: 让 app-server 退出直接终止 TUI 会把本地子进程故障升级成整个 Codex 退出；
  自动重启 TUI 或调用 `resume` 会越过启动器边界；重放全部排队请求可能重复 turn、prompt、
  goal 或 compact 副作用。
- Evidence: 新增失败回归后，`npm test` 通过 70/70；`npm run check`、`npm run test:live`、
  `git diff --check` 均退出 0。`npm run test:cli` 打包安装真实 CLI，第一代 fake app-server
  以 17 退出后，原 TUI WebSocket 通过第二代 app-server 重新握手并成功完成后续请求。
- Consequence: 普通模式可以承受本地 app-server 进程退出及其 WebSocket 10054/断开窗口，
  但不会伪装业务 RPC 的 exactly-once。断线前已投递而未返回的请求仍属于不确定结果。
  断线期间新收到的业务请求不会跨 app-server 代际排队；带 ID 的请求返回明确的未发送错误。
  replacement 的异步 spawn failure 继续按封顶退避重试，TUI 或信号退出会取消退避与 readiness
  探针。
