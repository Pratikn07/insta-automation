import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiMutation } from "@/lib/api";
import type { DeliveryMode, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { linkSaveError } from "./linkGuideErrors";

const BUTTON_LABEL_MAX = 20;
const CARD_TEXT_MAX = 80;
const FOLLOW_BUTTON_LABEL = "Follow @tinysoho";
const DEFAULT_SUBTITLE = "Tap below to open it.";

export function GuideTypeSwitch({
  value,
  onChange,
  disabled,
}: {
  value: DeliveryMode;
  onChange: (mode: DeliveryMode) => void;
  disabled?: boolean;
}) {
  const options: { mode: DeliveryMode; title: string; subtitle: string }[] = [
    { mode: "gated", title: "Gated", subtitle: "Follow first, then the steps below" },
    { mode: "link", title: "Link", subtitle: "One button to a page, no follow" },
  ];
  return (
    <div className="space-y-2">
      <Label>Guide type</Label>
      <div className="grid max-w-md grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={value === option.mode}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={cn(
              "rounded-md border bg-card/40 p-3 text-left transition-colors",
              value === option.mode ? "border-foreground/40 bg-accent/40" : "hover:bg-accent/20",
            )}
          >
            <div className="text-sm font-medium">{option.title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{option.subtitle}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The link guide's settings, with a preview of the card a parent receives. */
export function LinkGuidePanel({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const [linkUrl, setLinkUrl] = useState(resource.linkUrl ?? "");
  const [buttonLabel, setButtonLabel] = useState(resource.linkButtonLabel ?? "Open the recipes");
  const [title, setTitle] = useState(resource.linkCardTitle ?? "");
  const [subtitle, setSubtitle] = useState(resource.linkCardSubtitle ?? "");

  const save = useMutation({
    mutationKey: ["sequence-save", resource.id],
    mutationFn: () =>
      apiMutation<Resource>(`/resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          deliveryMode: "link",
          linkUrl: linkUrl.trim(),
          linkButtonLabel: buttonLabel.trim(),
          linkCardTitle: title.trim() || null,
          linkCardSubtitle: subtitle.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Link saved");
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (error) => toast.error(linkSaveError(error)),
  });

  const labelLength = [...buttonLabel.trim()].length;
  const canSave =
    /^https:\/\/\S+$/.test(linkUrl.trim()) &&
    labelLength >= 1 &&
    labelLength <= BUTTON_LABEL_MAX &&
    !save.isPending;
  const previewTitle = title.trim() || resource.name;
  const previewSubtitle = subtitle.trim() || resource.description?.trim() || DEFAULT_SUBTITLE;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label="Page address"
          hint="Parents land here after tapping the button. Changing it also updates links already sent."
        >
          <Input
            type="url"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://mycuratedhaven.com/halloween"
          />
        </Field>
        <Field label="Button text" hint={`${labelLength}/${BUTTON_LABEL_MAX} characters.`}>
          <Input
            value={buttonLabel}
            onChange={(event) => setButtonLabel(event.target.value)}
            placeholder="Open the recipes"
          />
        </Field>
        <Field label="Card title" hint="Optional. Uses the guide name when empty.">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={resource.name}
            maxLength={CARD_TEXT_MAX}
          />
        </Field>
        <Field label="Card subtitle" hint="Optional. Uses the guide description when empty.">
          <Input
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            placeholder="8 toddler-friendly recipes, ready to cook"
            maxLength={CARD_TEXT_MAX}
          />
        </Field>
        <Button type="submit" variant="brand" disabled={!canSave}>
          {save.isPending ? "Saving…" : "Save link"}
        </Button>
      </form>

      <aside aria-label="Card preview" className="rounded-lg border border-line bg-card/40 p-4">
        <p className="label-caps">What the parent gets</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-background">
          <div className="p-3">
            <p className="text-sm font-medium">{previewTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{previewSubtitle}</p>
          </div>
          <div className="border-t border-t-line px-3 py-2 text-center text-sm text-signal">
            {buttonLabel.trim() || "Open the recipes"}
          </div>
          <div className="border-t border-t-line px-3 py-2 text-center text-sm text-signal">
            {FOLLOW_BUTTON_LABEL}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          With the card switch on and a published cover, the cover image sits on top.
          Otherwise parents get the title and the link as plain text.
        </p>
      </aside>
    </div>
  );
}
