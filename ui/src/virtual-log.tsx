import { useState, useMemo } from "react";
export function VirtualLog({ text, label }: { text: string; label: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 22,
    height = Math.min(320, Math.max(66, lines.length * rowHeight));
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight) - 5),
    Math.max(0, lines.length - 1),
  );
  const visible = lines.slice(
    start,
    start + Math.ceil(height / rowHeight) + 10,
  );
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{
        height,
        overflow: "auto",
        background: "#f4f6fa",
        fontSize: 14,
        lineHeight: `${rowHeight}px`,
        fontFamily: "monospace",
        marginBlock: 10,
      }}
    >
      <div
        style={{
          height: lines.length * rowHeight,
          position: "relative",
          minWidth: "100%",
          width: "max-content",
        }}
      >
        <pre
          style={{
            position: "absolute",
            top: start * rowHeight,
            margin: 0,
            padding: 0,
            lineHeight: `${rowHeight}px`,
            whiteSpace: "pre",
            background: "transparent",
            fontSize: 14,
            maxHeight: "none",
            overflow: "visible",
          }}
        >
          {visible.map((line, i) => (
            <div key={start + i} data-log-line={start + i + 1}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
