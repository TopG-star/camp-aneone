"use client";

import type { OffsetPaginationMeta } from "@oneon/contracts";
import { Button } from "@/components/ui/button";

export function Pager({ pagination, onOffsetChange }: { pagination: OffsetPaginationMeta; onOffsetChange: (offset: number) => void }) {
  const { offset, limit, total, hasMore } = pagination;
  return (
    <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-label-md meta-copy">
        Showing {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)} of {total}
      </p>
      <div className="flex w-full gap-2 sm:w-auto">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={!hasMore} onClick={() => onOffsetChange(offset + limit)}>Next</Button>
      </div>
    </div>
  );
}
