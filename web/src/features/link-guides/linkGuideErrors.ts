import { apiErrorCode } from "@/lib/api";

const LINK_ERRORS: Record<string, string> = {
  link_url_required: "Add the page address.",
  link_url_invalid: "That isn't a web address.",
  link_url_not_https: "Use an address that starts with https://.",
  link_url_host_not_allowed: "That site isn't on the allowed list.",
  link_button_label_required: "Add the button text.",
  link_button_label_too_long: "Button text can be up to 20 characters.",
  link_card_title_too_long: "The card title can be up to 80 characters.",
  link_card_subtitle_too_long: "The card subtitle can be up to 80 characters.",
};

export function linkSaveError(error: unknown): string {
  const code = apiErrorCode(error);
  return (code ? LINK_ERRORS[code] : undefined) ?? "Couldn't save the link. Check your connection and try again.";
}
