export type NavGroup = "Measure" | "Publish" | "Audience" | "System";

export type NavDestination = {
  path: string;
  label: string;
  mobileTitle: string;
  group: NavGroup | null;
};

export type NavDestinationGroup = {
  heading: NavGroup;
  items: readonly NavDestination[];
};

export const HOME_DESTINATION: NavDestination = {
  path: "/",
  label: "Home",
  mobileTitle: "Home",
  group: null,
};

export const NAV_GROUPS: readonly NavDestinationGroup[] = [
  {
    heading: "Measure",
    items: [
      { path: "/insights", label: "Insights", mobileTitle: "Insights", group: "Measure" },
      { path: "/funnels", label: "Funnels", mobileTitle: "Funnels", group: "Measure" },
    ],
  },
  {
    heading: "Publish",
    items: [
      { path: "/content", label: "Content", mobileTitle: "Content", group: "Publish" },
      { path: "/keywords", label: "Keywords", mobileTitle: "Keywords", group: "Publish" },
      { path: "/guides", label: "Guides", mobileTitle: "Guides", group: "Publish" },
    ],
  },
  {
    heading: "Audience",
    items: [
      {
        path: "/conversations",
        label: "Conversations",
        mobileTitle: "Conversations",
        group: "Audience",
      },
      {
        path: "/dm-recovery",
        label: "DM recovery",
        mobileTitle: "DM recovery",
        group: "Audience",
      },
      {
        path: "/historical-recovery",
        label: "Historical recovery",
        mobileTitle: "Historical recovery",
        group: "Audience",
      },
    ],
  },
  {
    heading: "System",
    items: [
      // Two destinations, not one. A switch has a state; an experiment has a
      // result. One page called "Things we're testing" promised a test behind
      // every row and only two of sixteen were ever tests.
      {
        path: "/experiments",
        label: "Experiments",
        mobileTitle: "Experiments",
        group: "System",
      },
      { path: "/switches", label: "Switches", mobileTitle: "Switches", group: "System" },
      { path: "/activity", label: "Activity", mobileTitle: "Activity", group: "System" },
      { path: "/assistant", label: "Assistant", mobileTitle: "Assistant", group: "System" },
    ],
  },
];

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  HOME_DESTINATION,
  ...NAV_GROUPS.flatMap((group) => group.items),
];

export function titleForPath(pathname: string): string {
  const destination = NAV_DESTINATIONS.find((item) => item.path === pathname);
  if (destination) return destination.mobileTitle;
  if (pathname.startsWith("/guides/")) return "Guide editor";
  return "Tiny Soho";
}
