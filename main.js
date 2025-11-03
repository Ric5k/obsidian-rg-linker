// ===== Obsidian API =====
const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile
} = require("obsidian");

// ===== デフォルト設定 =====
// ※ ignoreLinkFolders / keywordLimit は廃止
const DEFAULT_SETTINGS = /** @type {const} */ ({
  rgPath: "rg",
  maxLinks: 10,
  minScore: 1,
  insertPlace: "bottom", // "top" | "bottom"
  caseSensitive: false,
  wordRegexp: true,
  ignorePatterns: ".obsidian,node_modules,.git",
  // フォルダ除外（複数・改行/カンマ区切り）
  ignoreSearchFolders: "",
  // スコア調整
  minKeywordOverlap: 1,
  titleWeight: 3,
});

// ===== 内部定数 =====
// UIからの制御は廃止。過剰負荷回避のため内部だけで上限を持つ
const INTERNAL_KEYWORD_LIMIT = 20;

// ===== ユーティリティ =====

/** 本文からキーワード抽出（内部上限のみ） */
function extractKeywords(markdown) {
  const text = (markdown || "")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .toLowerCase();

  const words = text.match(/[a-z0-9]{3,}|[ぁ-んァ-ヶ一-龠々]{2,}/g) ?? [];
  const stop = new Set([
    "the",
    "and",
    "for",
    "are",
    "this",
    "that",
    "with",
    "from",
    "have",
    "has",
    "you",
    "your",
    "about",
    "into",
    "also",
    "using",
    "when",
    "where",
    "what",
    "http",
    "https",
  ]);

  const uniq = [];
  for (const w of words) {
    if (stop.has(w)) continue;
    if (!uniq.includes(w)) uniq.push(w);
    if (uniq.length >= INTERNAL_KEYWORD_LIMIT) break;
  }
  return uniq;
}

/** タイトル（ファイル名）を分割してトークン化 */
function tokenizeName(name) {
  return (name || "")
    .replace(/\.[^/.]+$/, "") // 拡張子除去
    .toLowerCase()
    .split(/[^a-z0-9ぁ-んァ-ヶ一-龠々]+/g)
    .filter((w) => w && w.length >= 2);
}

/** 正規表現エスケープ */
function escapeRg(s) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** 入出力用のフォルダ正規化（先頭末尾の/を除去、区切りを/に統一） */
function normalizeFolderPath(folder) {
  return folder.replace(/^[\\/]+|[\\/]+$/g, "").replace(/\\/g, "/");
}

function splitInputList(input) {
  return (input ? input.split(/\r?\n|,/g) : [])
    .map((s) => s.trim())
    .filter(Boolean);
}

/** CSV/改行のフォルダ一覧を正規化 */
function parseFolderList(input) {
  return splitInputList(input)
    .map((s) => normalizeFolderPath(s))
    .filter(Boolean);
}

/** CSV/改行のパターン一覧（整形のみ） */
function parsePatternList(input) {
  return splitInputList(input);
}

/**
 * ripgrep 実行
 * @typedef {{ path: string; lineNumber: number }} RgMatch
 * @param {string} rgPath
 * @param {string} vaultPath
 * @param {string[]} terms
 * @param {{ caseSensitive: boolean; wordRegexp: boolean; ignorePatterns?: string[]; ignoreFolders?: string[] }} opts
 * @returns {Promise<RgMatch[]>}
 */
async function runRipgrep(rgPath, vaultPath, terms, opts) {
  if (!terms.length) return [];
  const patt = terms.map((t) => escapeRg(t)).join("|");

  const args = [
    "--json",
    "-n",
    "--no-heading",
    "--hidden",
    "--color",
    "never",
    "-g",
    "!**/*.png",
    "-g",
    "!**/*.jpg",
    "-g",
    "!**/*.jpeg",
    "-g",
    "!**/*.pdf",
    "-g",
    "!**/*.webp",
  ];

  // 大文字小文字
  if (opts.caseSensitive) args.push("-s");
  else args.push("-i");

  // 単語境界
  if (opts.wordRegexp) args.push("-w");

  // 除外指定を集約
  const excludeSet = new Set();
  const pushExclude = (glob) => {
    if (!glob) return;
    const sanitized = glob.replace(/^!+/, "").trim();
    if (!sanitized) return;
    excludeSet.add(sanitized.replace(/\\/g, "/"));
  };

  if (opts.ignoreFolders?.length) {
    for (const folderRaw of opts.ignoreFolders) {
      const folder = normalizeFolderPath(folderRaw);
      if (!folder) continue;
      pushExclude(`${folder}/**`);
      if (!folder.includes("/")) pushExclude(`**/${folder}/**`);
    }
  }

  if (opts.ignorePatterns?.length) {
    for (const patternRaw of opts.ignorePatterns) {
      const pattern = patternRaw.replace(/^!+/, "").trim();
      if (!pattern) continue;
      if (/[\\*?\[\]]/.test(pattern)) {
        pushExclude(pattern);
      } else {
        const asFolder = normalizeFolderPath(pattern);
        if (!asFolder) continue;
        pushExclude(`${asFolder}/**`);
        if (!asFolder.includes("/")) pushExclude(`**/${asFolder}/**`);
      }
    }
  }

  for (const glob of excludeSet) args.push("-g", `!${glob}`);
  args.push(patt, vaultPath);

  const { execFile } = require("child_process");
  return await new Promise((resolve, reject) => {
    execFile(rgPath, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const matches = [];
      for (const line of (stdout || "").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "match") {
            const path = obj.data.path.text;
            const ln =
              obj.data.submatches?.[0]?.line_number ??
              obj.data.line_number ??
              0;
            matches.push({ path, lineNumber: ln });
          }
        } catch {
          /* parse error は無視 */
        }
      }
      resolve(matches);
    });
  });
}

// ===== プラグイン本体 =====

class RgLinkerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // メインコマンド
    this.addCommand({
      id: "rg-linker-insert-links",
      name: "Find similar notes (ripgrep) and insert links",
      callback: () =>
        this.findAndInsertLinks().catch((err) => {
          console.error(err);
          new Notice("RG Linker: error. See console.");
        }),
    });

    this.addSettingTab(new RgLinkerSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * 類似ノートのリンクを生成して挿入
   */
  async findAndInsertLinks() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return new Notice("No active file.");
    if (!(file instanceof TFile)) return;

    // 検索語：本文 + タイトル
    const md = await this.app.vault.read(file);
    const terms = extractKeywords(md);
    for (const w of tokenizeName(file.basename)) {
      if (!terms.includes(w)) terms.push(w); // タイトル語も検索語に追加
    }
    if (!terms.length) return new Notice("No keywords extracted.");

    const adapter = this.app.vault.adapter;
    const vaultPath = adapter?.basePath || adapter?.getBasePath?.();
    if (!vaultPath) {
      new Notice("RG Linker: cannot determine vault path.");
      return;
    }

    // ripgrep ignore
    const ignorePatterns = parsePatternList(this.settings.ignorePatterns);
    const ignoreSearchFolders = parseFolderList(
      this.settings.ignoreSearchFolders,
    );

    // ripgrep 実行
    const matches = await runRipgrep(this.settings.rgPath, vaultPath, terms, {
      caseSensitive: this.settings.caseSensitive,
      wordRegexp: this.settings.wordRegexp,
      ignorePatterns,
      ignoreFolders: ignoreSearchFolders,
    });

    // ターゲット（現在ノート）の語集合（本文+タイトル）
    const targetBody = new Set(extractKeywords(md));
    const targetTitle = new Set(tokenizeName(file.basename));
    const targetAll = new Set([...targetBody, ...targetTitle]);

    // 一次スコア（rgのヒット数）
    const hitMap = new Map();
    for (const m of matches) {
      if (m.path.endsWith(file.path)) continue; // 自分は除外
      hitMap.set(m.path, (hitMap.get(m.path) ?? 0) + 1);
    }
    if (hitMap.size === 0) return new Notice("No similar notes found.");

    // 候補化
    const CANDIDATE_POOL_LIMIT = 60;
    const rankedEntries = [...hitMap.entries()].sort((a, b) => b[1] - a[1]);
    let baseEntries = rankedEntries
      .filter(([, sc]) => sc >= this.settings.minScore)
      .slice(0, CANDIDATE_POOL_LIMIT);
    if (baseEntries.length === 0) {
      baseEntries = rankedEntries.slice(0, CANDIDATE_POOL_LIMIT);
    }

    const candidates = [];
    const fallbackCandidates = [];
    for (const [absPath, rgScore] of baseEntries) {
      let rel = absPath;
      if (absPath.startsWith(vaultPath + "/"))
        rel = absPath.slice(vaultPath.length + 1);
      else if (absPath.startsWith(vaultPath + "\\"))
        rel = absPath.slice(vaultPath.length + 1);
      if (!rel.endsWith(".md")) continue;

      const relNorm = rel.replace(/\\/g, "/");

      const tf = this.app.vault.getAbstractFileByPath(relNorm);
      if (!(tf instanceof TFile)) continue;

      const content = await this.app.vault.read(tf);
      const bodyKw = extractKeywords(content);
      const titleKw = tokenizeName(tf.basename);

      // 重なり数
      let overlapBody = 0,
        overlapTitle = 0;
      for (const kw of bodyKw) if (targetBody.has(kw)) overlapBody++;
      for (const kw of titleKw)
        if (targetTitle.has(kw) || targetBody.has(kw)) overlapTitle++;

      const totalOverlap = overlapBody + overlapTitle;
      if (totalOverlap === 0) continue;

      const candidateTokens = new Set([...bodyKw, ...titleKw]);
      const unionTokens = new Set(targetAll);
      for (const kw of candidateTokens) unionTokens.add(kw);
      const unionSize = unionTokens.size || 1;
      const similarity = totalOverlap / unionSize;

      const weightedOverlap =
        overlapBody + this.settings.titleWeight * overlapTitle;
      const score = weightedOverlap * (1 + similarity) + Math.min(2, rgScore);

      const entry = {
        name: relNorm.replace(/\.md$/, ""),
        rel: relNorm,
        score,
        overlapBody,
        overlapTitle,
        similarity,
        totalOverlap,
      };
      fallbackCandidates.push(entry);
      if (totalOverlap < this.settings.minKeywordOverlap) continue;

      candidates.push(entry);
    }

    let finalCandidates = candidates.length ? candidates : fallbackCandidates;
    if (!finalCandidates.length) return new Notice("No similar notes found.");

    // 並び順：score > similarity > overlapTitle > overlapBody > name
    finalCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (b.overlapTitle !== a.overlapTitle)
        return b.overlapTitle - a.overlapTitle;
      if (b.overlapBody !== a.overlapBody) return b.overlapBody - a.overlapBody;
      return a.name.localeCompare(b.name);
    });

    const top = finalCandidates.slice(0, this.settings.maxLinks);
    const links = top.map((c) => `[[${c.name}]]`);

    // === 出力（Graph View が拾う形） ===
    const blockTitle = `> Similar notes`;
    const list = links.map((l) => `- ${l}`).join("\n");
    const newBlock = `\n\n${blockTitle}\n${list}\n`;

    // 既存ブロック置換（旧形式も捕捉）
    const LINKS_BLOCK_PATTERNS = [
      /\n---\nLinks\n(?:- \[\[[^\]]+\]\]\n?)+/m,
      /(?:^|\n)> Similar notes \(rg(?:\s*:\s*[^\)]+)?\)\n(?:- \[\[[^\]]+\]\]\n?)+/m,
      /(?:^|\n)> Similar notes(?:\s*\([^\)]+\))?\n(?:- \[\[[^\]]+\]\]\n?)+/m,
    ];

    await this.app.vault.process(file, (data) => {
      for (const re of LINKS_BLOCK_PATTERNS) {
        if (re.test(data)) return data.replace(re, newBlock);
      }
      return this.settings.insertPlace === "top"
        ? newBlock + data
        : data + newBlock;
    });

    new Notice(`Inserted ${links.length} links.`);
  }
}

// ===== 設定タブ =====

class RgLinkerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** フォルダチップの描画 */
  renderFolderChips(container, getList, setList) {
    container.empty();
    const list = getList();
    const wrap = container.createDiv({ cls: "rg-folder-chip-wrap" });

    if (list.length === 0) {
      wrap.createEl("div", { text: "No folders excluded.", cls: "rg-muted" });
    } else {
      for (const f of list) {
        const chip = wrap.createDiv({ cls: "rg-chip" });
        chip.createSpan({ text: f });
        const x = chip.createEl("button", { text: "×", cls: "rg-chip-x" });
        x.addEventListener("click", async () => {
          const next = list.filter((v) => v !== f);
          await setList(next);
          this.renderFolderChips(container, getList, setList);
        });
      }
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "RG Linker Settings" });

    new Setting(containerEl)
      .setName("ripgrep path")
      .setDesc("Path to `rg` binary (e.g. /opt/homebrew/bin/rg)")
      .addText((t) =>
        t
          .setPlaceholder("rg")
          .setValue(this.plugin.settings.rgPath)
          .onChange(async (v) => {
            this.plugin.settings.rgPath = v || "rg";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Max links").addSlider((s) =>
      s
        .setLimits(1, 50, 1)
        .setValue(this.plugin.settings.maxLinks)
        .onChange(async (v) => {
          this.plugin.settings.maxLinks = v;
          await this.plugin.saveSettings();
        })
        .setDynamicTooltip(),
    );

    new Setting(containerEl)
      .setName("Min score (rg hits)")
      .setDesc("Minimum ripgrep hit count to enter candidate pool.")
      .addSlider((s) =>
        s
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.minScore)
          .onChange(async (v) => {
            this.plugin.settings.minScore = v;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip(),
      );

    new Setting(containerEl).setName("Insert position").addDropdown((d) =>
      d
        .addOptions({ top: "Top", bottom: "Bottom" })
        .setValue(this.plugin.settings.insertPlace)
        .onChange(async (v) => {
          this.plugin.settings.insertPlace = /** @type {"top"|"bottom"} */ (v);
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("Case sensitive").addToggle((t) =>
      t.setValue(this.plugin.settings.caseSensitive).onChange(async (v) => {
        this.plugin.settings.caseSensitive = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName("Word-regexp (-w)").addToggle((t) =>
      t.setValue(this.plugin.settings.wordRegexp).onChange(async (v) => {
        this.plugin.settings.wordRegexp = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Ignore patterns (rg -g)")
      .setDesc(
        "Comma/lines separated (e.g. .obsidian,node_modules,.git). Used in ripgrep search.",
      )
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.ignorePatterns).onChange(async (v) => {
          this.plugin.settings.ignorePatterns = v;
          await this.plugin.saveSettings();
        }),
      );

    // ===== 改良UI: Ignore search folders =====
    containerEl.createEl("h4", { text: "Ignore search folders" });
    const desc = containerEl.createDiv({ cls: "setting-item-description" });
    desc.setText("Exclude folders (relative to vault) from ripgrep search.");

    // チップの表示領域
    const chipContainer = containerEl.createDiv();

    const getList = () =>
      parseFolderList(this.plugin.settings.ignoreSearchFolders);
    const setList = async (arr) => {
      this.plugin.settings.ignoreSearchFolders = arr.join("\n");
      await this.plugin.saveSettings();
    };

    this.renderFolderChips(chipContainer, getList, setList);

    // 入力＋追加ボタン
    let addInputRef = null;
    new Setting(containerEl)
      .setName("Add folder")
      .setDesc("Type a folder path (relative) and click Add.")
      .addText((t) => {
        t.setPlaceholder("Attachments / Archive/old / Private");
        addInputRef = t;
      })
      .addButton((b) => {
        b.setButtonText("Add").onClick(async () => {
          const raw = (addInputRef?.getValue() || "").trim();
          if (!raw) return new Notice("Enter a folder path.");
          const v = normalizeFolderPath(raw);
          if (!v) return;
          const list = getList();
          if (!list.includes(v)) {
            list.push(v);
            await setList(list);
            this.renderFolderChips(chipContainer, getList, setList);
          }
          addInputRef?.setValue("");
        });
      });

    // 現在ノートのフォルダをワンクリックで追加
    new Setting(containerEl)
      .setName("Quick add")
      .setDesc("Add the current note’s folder.")
      .addButton((b) => {
        b.setButtonText("Add current note’s folder").onClick(async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return new Notice("No active file.");
          const folder = normalizeFolderPath(file.parent?.path || "");
          if (!folder) return;
          const list = getList();
          if (!list.includes(folder)) {
            list.push(folder);
            await setList(list);
            this.renderFolderChips(chipContainer, getList, setList);
          }
        });
      });

    // 軽いスタイル（chips）
    const style = document.createElement("style");
    style.textContent = `
.rg-chip { display:inline-flex; align-items:center; gap:.4em; padding:.2em .6em; border-radius:9999px; border:1px solid var(--background-modifier-border); margin:.25em .35em .25em 0; }
.rg-chip-x { background:transparent; border:none; cursor:pointer; font-weight:bold; }
.rg-muted { opacity:.7; font-style:italic; }
.rg-folder-chip-wrap { margin-top:.25rem; }
`;
    containerEl.appendChild(style);

    // ===== 残りのスコア関連 =====
    new Setting(containerEl)
      .setName("Minimum keyword overlap")
      .setDesc("Require at least this many shared keywords (body + title).")
      .addSlider((s) =>
        s
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.minKeywordOverlap)
          .onChange(async (v) => {
            this.plugin.settings.minKeywordOverlap = v;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip(),
      );

    new Setting(containerEl)
      .setName("Title weight")
      .setDesc(
        "How strongly to weight title token overlaps vs body (default 3).",
      )
      .addSlider((s) =>
        s
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.titleWeight)
          .onChange(async (v) => {
            this.plugin.settings.titleWeight = v;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip(),
      );
  }
}

module.exports = RgLinkerPlugin;
