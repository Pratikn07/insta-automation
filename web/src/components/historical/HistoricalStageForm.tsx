import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CampaignRow } from "./historicalRecoveryViewModel";

export type HistoricalStageCaps = {
  batchSize: number;
  hourlyCap: number;
  dailyCap: number;
};

export function HistoricalStageForm({
  campaign,
  busy,
  onCancel,
  onSubmit,
}: {
  campaign: CampaignRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (caps: HistoricalStageCaps) => void;
}) {
  const [batchSize, setBatchSize] = useState(String(campaign.batchSize));
  const [hourlyCap, setHourlyCap] = useState(String(campaign.hourlyCap));
  const [dailyCap, setDailyCap] = useState(String(campaign.dailyCap));

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      batchSize: Number(batchSize),
      hourlyCap: Number(hourlyCap),
      dailyCap: Number(dailyCap),
    });
  }

  return (
    <Card className="mt-4 p-4">
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <h2 className="text-sm font-medium">Advance rollout stage</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Raise the campaign caps without changing the approved candidate list.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="historical-batch-size">Batch size</Label>
            <Input
              id="historical-batch-size"
              type="number"
              min={1}
              max={50}
              value={batchSize}
              onChange={(event) => setBatchSize(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="historical-hourly-cap">Hourly cap</Label>
            <Input
              id="historical-hourly-cap"
              type="number"
              min={1}
              max={200}
              value={hourlyCap}
              onChange={(event) => setHourlyCap(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="historical-daily-cap">Daily cap</Label>
            <Input
              id="historical-daily-cap"
              type="number"
              min={1}
              max={1000}
              value={dailyCap}
              onChange={(event) => setDailyCap(event.target.value)}
              required
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save stage
          </Button>
        </div>
      </form>
    </Card>
  );
}
