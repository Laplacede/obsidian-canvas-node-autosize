# Canvas Current Node Auto Size

一个用于 Obsidian Canvas 的文本节点自动调整大小插件。

它的目标很明确：只调整当前正在编辑的 Canvas 文本节点，不移动其它节点，不自动重排画布，尽量避免中文长文本在退出编辑时意外换行。

## 功能特点

- 只调整当前正在编辑的 Canvas 文本节点。
- 默认向右扩展，不会把后面的节点顶走。
- 支持向右、向左、从中心扩展。
- 编辑时自动扩宽节点，减少临界换行。
- 针对中文、日文、韩文提供额外宽度余量。
- 可选退出编辑时收紧宽度，默认关闭。
- 可调整单行高度和垂直留白，缓解 Canvas 节点出现竖向滚动条。
- 提供 debug 命令，方便排查 Canvas 节点测量问题。

## 适用场景

这个插件主要为下面这类用法设计：

- 在 Obsidian Canvas 中制作思维导图。
- 频繁创建短文本节点。
- 希望节点宽度随输入自动增长。
- 希望中文节点排版更稳定。
- 不希望自动布局逻辑移动已有节点。

如果你需要完整的自动排版、自动避让、节点群组重排，这个插件并不打算解决这些问题。

## 安装

目前这是开发版插件，可以手动安装。

1. 下载或克隆仓库。
2. 运行构建：

```bash
npm install
npm run build
```

3. 将以下文件放入你的 Obsidian vault 插件目录：

```text
.obsidian/plugins/canvas-current-node-auto-size/
├── main.js
└── manifest.json
```

4. 在 Obsidian 中关闭安全模式，启用 `Canvas Current Node Auto Size`。

## 开发

安装依赖：

```bash
npm install
```

开发构建：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

`npm run build` 会先执行 TypeScript 类型检查，然后通过 esbuild 生成 `main.js`。

## 设置说明

### Basics

#### Expansion direction

控制节点宽度变化时从哪里扩展。

- `Grow right`：向右扩展，默认选项，节点左边不动。
- `Grow from center`：从中心扩展，节点左右同时变化。
- `Grow left`：向左扩展，节点右边相对更稳定。

无论选择哪一种模式，插件都只移动当前节点，不会移动其它节点。

#### Tighten width on exit

退出编辑时是否收紧宽度。

默认关闭。建议先保持关闭，因为退出收紧是最容易导致节点突然变窄的功能。

开启后，插件只会在本次编辑确实改变过文本时收紧一次。

#### Maximum width

节点自动调整后的最大宽度。

默认值：`520`

如果你希望节点能拉得更长，可以调大它。

### Width

#### Base width padding

所有文本都会额外保留的基础横向空间。

默认值：`20`

如果节点总是贴得太紧，可以调大。若希望排版更紧凑，可以调小。

#### CJK extra width

包含中文、日文、韩文的行会额外增加的宽度。

默认值：`18`

如果中文长句在末尾临界位置仍然容易换行，优先调大这个参数。

#### Editing anti-wrap width

编辑过程中临时增加的防换行宽度。

默认值：`28`

它主要用于避免输入时刚到边界就折行。这个值只影响编辑过程中的宽度，不等同于最终收紧宽度。

#### Exit tighten padding

退出收紧时保留的宽度余量。

默认值：`40`

只有打开 `Tighten width on exit` 后才会显示和生效。

### Height

#### Single-line height

单行节点的最低高度。

默认值：`44`

如果单行退出编辑后出现文字被压扁或滚动条，可以调大。

#### Vertical padding

节点文本上下额外总高度。

默认值：`10`

如果多行节点出现竖向滚动条，可以调大。

### Advanced

#### Resize delay

输入后延迟多久执行 resize，单位是毫秒。

默认值：`40`

修改这个参数后需要重启 Obsidian 或重新加载插件。

#### Debug notices

打开后，每次插件测量节点时会显示 debug notice。

通常不需要开启。排查问题时可以配合下面的命令使用。

## 命令

插件提供两个命令，可以在 Obsidian 命令面板中使用：

- `Show last Canvas auto-size debug`
- `Copy last Canvas auto-size debug`

debug 内容包括当前节点 id、行数、原始宽度、实时宽度、退出收紧宽度、目标宽高等。

## 已知限制

- 当前主要支持 Canvas 文本节点。
- 不会自动移动其它节点。
- 不会做画布自动排版。
- 不直接修改 `.canvas` JSON 文件，而是通过 Obsidian Canvas 运行时节点对象调整大小。
- 高度测量采用保守估算，目标是稳定而不是像素级精确。
- 已保存过的设置不会因为默认值改变而自动改变；如果想使用新默认值，可以点击设置页里的恢复默认。

## 文档

项目中还有两份更详细的中文文档：

- [Obsidian Canvas 插件开发踩坑与收获记录](docs/canvas-development-notes.md)
- [项目代码结构与架构详解](docs/project-architecture.md)

如果你想继续开发 Canvas 插件，建议先看踩坑记录；如果你想理解本项目代码结构，建议看架构详解。

## 许可证

MIT

