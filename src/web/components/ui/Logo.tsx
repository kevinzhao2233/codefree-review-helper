import React from "react";
import { cn } from "../../lib/utils";

/**
 * 评审 Logo：圆角矩形卡片 + diff 评审界面抽象图形。
 * 卡片内为白色背景，圆角外透明，图形完整落在圆角内。
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 128 128"
      role="img"
      aria-label="codefree-review-helper"
      className={cn("shrink-0", className)}
    >
      {/* 大圆角矩形卡片（白色背景，圆角外透明） */}
      <rect x="4" y="4" width="120" height="120" rx="28" fill="#ffffff" />
      {/* 左侧：上下两个浅灰圆角方块 */}
      <rect x="22" y="26" width="30" height="30" rx="9" fill="#ececec" />
      <rect x="22" y="72" width="30" height="30" rx="9" fill="#ececec" />
      {/* 上块：灰色短横 */}
      <rect x="30" y="41" width="14" height="5" rx="2.5" fill="#9e9e9e" />
      {/* 下块：黑色加号 */}
      <g stroke="#111111" strokeWidth="5" strokeLinecap="round">
        <path d="M37 82v11" />
        <path d="M31.5 87.5h11" />
      </g>
      {/* 中部：黑色竖向分割线 */}
      <path d="M60 26v76" stroke="#111111" strokeWidth="4" strokeLinecap="round" />
      {/* 右侧：三条黑色横向文本线（左端对齐，长度递减） */}
      <g stroke="#111111" strokeWidth="10" strokeLinecap="round">
        <path d="M74 33h34" />
        <path d="M74 64h22" />
        <path d="M74 95h10" />
      </g>
    </svg>
  );
}
