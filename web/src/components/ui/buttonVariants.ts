import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        // Ink on gold, measured at 4.77:1. White on gold is 1.9:1 and was the
        // old dark-world pairing; carried over unchanged it would have failed
        // every contrast check on an ivory ground.
        brand: "bg-gold text-foreground hover:bg-gold-text hover:text-background",
        outline: "border bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Every size carries a 44px minimum under a coarse pointer. The visual
      // heights stay as they are on a mouse, so the ivory rhythm is unchanged
      // where it is read and the target is honoured where it is tapped.
      size: {
        default: "h-9 px-4 py-2 [@media(pointer:coarse)]:min-h-11",
        sm: "h-8 rounded-md px-3 text-xs [@media(pointer:coarse)]:min-h-11",
        lg: "h-10 rounded-md px-6 [@media(pointer:coarse)]:min-h-11",
        icon: "size-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
