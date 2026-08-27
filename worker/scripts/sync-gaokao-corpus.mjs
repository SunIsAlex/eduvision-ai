import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = fileURLToPath(new URL("../prompts/gaokao-corpus.json", import.meta.url));
const outputFlag = process.argv.indexOf("--output");
const outputRoot = outputFlag >= 0 && process.argv[outputFlag + 1]
  ? join(repoRoot, process.argv[outputFlag + 1])
  : join(repoRoot, ".gaokao-corpus");
const checkOnly = process.argv.includes("--check");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const subjectNames = {
  math: "数学",
  english: "英语",
  physics: "物理",
  chemistry: "化学",
  biology: "生物",
};

async function validateManifest() {
  const expected = new Set();
  for (const year of manifest.scope.years) {
    for (const subject of manifest.scope.subjects) expected.add(`${year}:${subject}`);
  }
  if (manifest.papers.length !== expected.size) {
    throw new Error(`资料清单应有 ${expected.size} 组，实际 ${manifest.papers.length} 组`);
  }
  for (const paper of manifest.papers) {
    const key = `${paper.year}:${paper.subject}`;
    if (!expected.delete(key)) throw new Error(`资料重复或超出范围：${key}`);
    for (const field of ["questionUrl", "answerUrl"]) {
      const url = new URL(paper[field]);
      if (url.protocol !== "https:" || url.hostname !== "gaokao.eol.cn") {
        throw new Error(`${key} 的 ${field} 不是允许的 HTTPS 档案来源`);
      }
    }
  }
  if (expected.size) throw new Error(`资料缺失：${[...expected].join(", ")}`);

  const authorityHosts = new Set([
    "gaokao.neea.edu.cn",
    "www.moe.gov.cn",
    "www.zjzs.net",
    "www.shmeea.edu.cn",
  ]);
  for (const reference of manifest.authorityReferences) {
    const url = new URL(reference.url);
    if (url.protocol !== "https:" || !authorityHosts.has(url.hostname)) {
      throw new Error(`评析来源不在权威白名单：${reference.url}`);
    }
  }

  for (const subject of manifest.scope.subjects) {
    const skill = await readFile(join(repoRoot, "worker", "prompts", subject, "SKILL.md"), "utf8");
    const declaredName = skill.match(/^---\r?\nname:\s*([^\r\n]+)/)?.[1]?.trim();
    if (declaredName !== subject) throw new Error(`${subject} SKILL 的 frontmatter 名称无效`);
    if (/\[TODO|TODO:/.test(skill)) throw new Error(`${subject} SKILL 仍含 TODO`);
  }
}

await validateManifest();
if (checkOnly) {
  console.log(`manifest ok: ${manifest.papers.length} papers, ${manifest.authorityReferences.length} authority references`);
  process.exit(0);
}

await mkdir(join(outputRoot, "documents"), { recursive: true });
await mkdir(join(outputRoot, "assets"), { recursive: true });

const fetchCache = new Map();
const assetCache = new Map();
const documentCache = new Map();

async function fetchBytes(url, attempt = 1) {
  const existing = fetchCache.get(url);
  if (existing) return existing;
  const request = (async () => {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "EduVision-Gaokao-Corpus/1.0 (+source-audit)" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        url: response.url,
        contentType: response.headers.get("content-type") ?? "",
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      fetchCache.delete(url);
      if (attempt < 3) return fetchBytes(url, attempt + 1);
      throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  fetchCache.set(url, request);
  return request;
}

function articlePageUrls(requestedUrl, html) {
  const count = Number(html.match(/var\s+_PAGE_COUNT\s*=\s*"(\d+)"/)?.[1] ?? 1);
  const name = html.match(/var\s+_PAGE_NAME\s*=\s*"([^"]+)"/)?.[1];
  if (!name || !Number.isInteger(count) || count < 2 || count > 40) return [requestedUrl];
  const urls = [];
  for (let index = 0; index < count; index += 1) {
    urls.push(new URL(`${name}${index === 0 ? "" : `_${index}`}.shtml`, requestedUrl).href);
  }
  return urls;
}

function editorFragment(html) {
  const start = html.search(/<div\s+class=(?:"TRS_Editor"|TRS_Editor)[^>]*>/i);
  if (start < 0) return "";
  const pageNav = html.indexOf('<div class="perpage"', start);
  const articleEnd = html.indexOf('<div class="content-bot"', start);
  const candidates = [pageNav, articleEnd].filter((value) => value > start);
  const end = candidates.length ? Math.min(...candidates) : html.length;
  return html.slice(start, end).trim();
}

function imageUrls(fragment, pageUrl) {
  const urls = new Set();
  for (const tag of fragment.match(/<img\b[^>]*>/gi) ?? []) {
    const value = tag.match(/(?:src|oldsrc)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!value || value.startsWith("data:")) continue;
    const url = new URL(value, pageUrl);
    if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.href);
  }
  return [...urls];
}

function extensionFor(url, contentType) {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (/^\.(?:png|jpe?g|webp|gif)$/.test(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

async function downloadAsset(url) {
  const existing = assetCache.get(url);
  if (existing) return existing;
  const work = (async () => {
    const response = await fetchBytes(url);
    if (!response.contentType.startsWith("image/") && response.bytes.length < 1024) {
      throw new Error(`${url}: 返回内容不是有效试卷图片`);
    }
    const sha256 = createHash("sha256").update(response.bytes).digest("hex");
    const filename = `${sha256}${extensionFor(response.url, response.contentType)}`;
    await writeFile(join(outputRoot, "assets", filename), response.bytes);
    return { sourceUrl: url, resolvedUrl: response.url, file: `assets/${filename}`, sha256, bytes: response.bytes.length };
  })();
  assetCache.set(url, work);
  return work;
}

async function crawlDocument(url, expectedYear, expectedSubject) {
  const cacheKey = `${url}|${expectedYear}|${expectedSubject}`;
  const existing = documentCache.get(cacheKey);
  if (existing) return existing;
  const work = (async () => {
    const first = await fetchBytes(url);
    const firstHtml = first.bytes.toString("utf8");
    const title = (firstHtml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!title.includes(String(expectedYear)) || !title.includes(expectedSubject)) {
      throw new Error(`${url}: 页面标题与期望的 ${expectedYear} ${expectedSubject} 不符（${title}）`);
    }
    const pages = articlePageUrls(url, firstHtml);
    const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const directory = join(outputRoot, "documents", id);
    await mkdir(directory, { recursive: true });
    const pageResults = [];
    for (let index = 0; index < pages.length; index += 1) {
      const pageUrl = pages[index];
      const response = pageUrl === url ? first : await fetchBytes(pageUrl);
      const html = response.bytes.toString("utf8");
      const fragment = editorFragment(html);
      if (!fragment) throw new Error(`${pageUrl}: 未找到试题正文`);
      const assets = await Promise.all(imageUrls(fragment, response.url).map(downloadAsset));
      const file = `documents/${id}/page-${String(index + 1).padStart(2, "0")}.html`;
      await writeFile(join(outputRoot, file), fragment);
      const sha256 = createHash("sha256").update(fragment).digest("hex");
      pageResults.push({ sourceUrl: pageUrl, resolvedUrl: response.url, file, sha256, assets });
    }
    const combined = pageResults.map((page) => page.sha256).join(" ");
    return {
      id,
      sourceUrl: url,
      expectedYear,
      expectedSubject,
      pageCount: pageResults.length,
      assetCount: pageResults.reduce((sum, page) => sum + page.assets.length, 0),
      pages: pageResults,
      auditKey: createHash("sha256").update(combined).digest("hex"),
    };
  })();
  documentCache.set(cacheKey, work);
  return work;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const papers = await mapLimit(manifest.papers, 4, async (paper) => {
  const subjectName = subjectNames[paper.subject];
  const question = await crawlDocument(paper.questionUrl, paper.year, subjectName);
  const answer = paper.answerUrl === paper.questionUrl
    ? question
    : await crawlDocument(paper.answerUrl, paper.year, subjectName);
  console.log(`fetched ${paper.year} ${subjectName} ${paper.paper}: question=${question.pageCount}p answer=${answer.pageCount}p`);
  return { ...paper, questionDocument: question.id, answerDocument: answer.id };
});

const resolvedDocuments = await Promise.all([...documentCache.values()]);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceManifest: "worker/prompts/gaokao-corpus.json",
  papers,
  documents: resolvedDocuments,
  totals: {
    papers: papers.length,
    documents: resolvedDocuments.length,
    pages: resolvedDocuments.reduce((sum, document) => sum + document.pageCount, 0),
    assets: new Set(resolvedDocuments.flatMap((document) => document.pages.flatMap((page) => page.assets.map((asset) => asset.sha256)))).size,
  },
};
await writeFile(join(outputRoot, "index.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`corpus ready: ${report.totals.papers} papers, ${report.totals.documents} documents, ${report.totals.pages} pages, ${report.totals.assets} unique assets`);
