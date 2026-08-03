import { useEffect, useRef, useState } from "react";
import { ExternalLink, LineChart, Loader2 } from "lucide-react";

interface PlotExpression {
  latex: string;
  color?: string;
  hidden?: boolean;
  label?: string;
}

interface PlotSpec {
  expressions: PlotExpression[];
  viewport?: { xMin: number; xMax: number; yMin: number; yMax: number };
  degreeMode?: boolean;
}

interface DesmosCalculator {
  setExpressions(expressions: Array<Record<string, unknown>>): void;
  setMathBounds(bounds: { left: number; right: number; bottom: number; top: number }): void;
  destroy(): void;
}

interface DesmosApi {
  GraphingCalculator(
    element: HTMLElement,
    options: Record<string, unknown>
  ): DesmosCalculator;
}

declare global {
  interface Window {
    Desmos?: DesmosApi;
  }
}

let desmosLoader: Promise<DesmosApi> | null = null;

function parsePlotSpec(raw: string): PlotSpec | null {
  try {
    const value = JSON.parse(raw) as Partial<PlotSpec>;
    if (!Array.isArray(value.expressions)) return null;
    const expressions = value.expressions
      .filter((item): item is PlotExpression => Boolean(item) && typeof item.latex === "string")
      .slice(0, 8);
    if (expressions.length === 0) return null;
    return { expressions, viewport: value.viewport, degreeMode: value.degreeMode === true };
  } catch {
    return null;
  }
}

async function getDesmosApi(): Promise<DesmosApi> {
  if (window.Desmos) return window.Desmos;
  if (desmosLoader) return desmosLoader;
  desmosLoader = (async () => {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("无法读取绘图配置");
    const config = (await response.json()) as { desmosApiKey?: string };
    if (!config.desmosApiKey) throw new Error("尚未配置正式 Desmos API key");

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => reject(new Error("Desmos 加载超时")), 8_000);
      script.src = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${encodeURIComponent(config.desmosApiKey!)}`;
      script.async = true;
      script.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("Desmos 网络加载失败"));
      };
      document.head.appendChild(script);
    });
    if (!window.Desmos) throw new Error("Desmos API 初始化失败");
    return window.Desmos;
  })().catch((error) => {
    desmosLoader = null;
    throw error;
  });
  return desmosLoader;
}

export function FunctionPlot({ raw }: { raw: string }) {
  const spec = parsePlotSpec(raw);
  const hostRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!expanded || !spec || !hostRef.current) return;
    let active = true;
    let calculator: DesmosCalculator | undefined;
    setState("loading");
    setError("");
    void getDesmosApi()
      .then((Desmos) => {
        if (!active || !hostRef.current) return;
        calculator = Desmos.GraphingCalculator(hostRef.current, {
          // Presentation-only graph: expressions are already listed in our
          // own compact card above, so do not expose the Desmos workspace.
          expressions: false,
          keypad: false,
          settingsMenu: false,
          expressionsTopbar: false,
          images: false,
          folders: false,
          notes: false,
          links: false,
          degreeMode: spec.degreeMode === true,
          invertedColors: true,
        });
        calculator.setExpressions(
          spec.expressions.map((expression, index) => ({
            id: `eduvision-${index}`,
            latex: expression.latex,
            ...(expression.color ? { color: expression.color } : {}),
            hidden: expression.hidden === true,
            ...(expression.label ? { label: expression.label, showLabel: true } : {}),
          }))
        );
        if (spec.viewport) {
          calculator.setMathBounds({
            left: spec.viewport.xMin,
            right: spec.viewport.xMax,
            bottom: spec.viewport.yMin,
            top: spec.viewport.yMax,
          });
        }
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "图像加载失败");
        setState("fallback");
      });
    return () => {
      active = false;
      calculator?.destroy();
    };
  }, [expanded, raw]);

  if (!spec) return <p className="text-xs text-red-300">绘图参数无法解析</p>;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-slate-800 bg-slate-950/70">
      <div className="space-y-1 px-3 py-2 font-mono text-xs text-sky-200">
        {spec.expressions.map((expression, index) => (
          <div key={`${index}-${expression.latex}`} className="flex items-center gap-2 break-all">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: expression.color ?? ["#2d70b3", "#c74440", "#388c46"][index % 3] }}
            />
            <span>{expression.latex}</span>
          </div>
        ))}
      </div>
      {expanded && (
        <div className="relative h-80 border-t border-slate-800">
          <div ref={hostRef} className="h-full w-full" />
          {state === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/90 text-xs text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在加载 Desmos…
            </div>
          )}
          {state === "fallback" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 px-5 text-center text-xs text-slate-400">
              <span>{error}；已保留表达式，可继续阅读答案。</span>
              <a className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300" href="https://www.desmos.com/calculator" target="_blank" rel="noreferrer">
                打开 Desmos <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="flex w-full items-center justify-center gap-1.5 border-t border-slate-800 px-3 py-2 text-xs text-sky-400 hover:bg-slate-900 hover:text-sky-300"
        onClick={() => setExpanded((value) => !value)}
      >
        <LineChart className="h-3.5 w-3.5" /> {expanded ? "收起图像" : "展开交互图像"}
      </button>
    </div>
  );
}
