续写鸡 NEXT 一体化 v1.0.1

这是“全新的独立扩展”，不是旧续写鸡的补丁。

已内置：
1. 长篇编辑器 + SillyTavern 当前模型 generateRaw 续写
2. 动态 Prompt 模板：{{变量}}、{{#if}}、{{#unless}}、<%= var %>
3. ScriptEvents 式内置事件总线 + SillyTavern 事件桥
4. 内置关键词触发世界书
5. 长期记忆 / 手动总结 / 自动总结
6. RP 世界状态
7. DAMAGE / REPAIR 连续状态
8. 电子眼 / 机体 HUD
9. 自检面板和事件日志
10. 每聊天/角色作用域数据隔离
11. 世界书/记忆/完整状态 JSON 导入导出

安装：
- 把整个 XuXieJi_Next 文件夹放进 SillyTavern/public/scripts/extensions/third-party/
- 或将 ZIP 用 SillyTavern 的扩展安装方式导入（取决于你使用的前端版本）。
- 刷新酒馆，打开“扩展”设置，找到“续写鸡 NEXT 一体化”。

重要：
- 不需要旧续写鸡。
- 不需要单独安装 ST-Prompt-Template。
- 不需要单独安装 Extension-ScriptEvents。
- 动态 Prompt、事件总线、世界书、RP/DAMAGE/HUD 都是插件自身代码。


v1.0.1：修复手机端编辑器弹窗大面积黑屏、标题和按钮不易看到的问题。
