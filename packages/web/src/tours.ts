// The guided tours. Text lives in the i18n files under `tour.<id>.<key>`;
// what is here is only the choreography — which element, on which page.
//
// `target` is a `data-tour` attribute, never a class or an id used for
// styling. A tour that breaks when somebody restyles a button is a tour
// nobody will maintain.

export interface TourStep {
  /** Key under `tour.<tourId>.` for the title and body strings. */
  key: string;
  /** `data-tour` value of the element to point at. Omitted = centred card. */
  target?: string;
  /** Go here first. Only set it on the step that changes page. */
  route?: string;
  /**
   * Open the sidebar first. On a phone it is a drawer, and starting a tour
   * closes it — so a step about the menu would otherwise point at something
   * that is not on screen.
   */
  needsNav?: boolean;
}

export interface Tour {
  id: string;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    // Deliberately first and deliberately short: somebody who has just logged
    // in has no reason to trust a ten-minute tour.
    id: 'basics',
    steps: [
      { key: 'welcome', route: '/' },
      { key: 'nav', target: 'nav', needsNav: true },
      { key: 'metrics', target: 'metrics' },
      { key: 'tree', target: 'location-tree' },
      { key: 'cards', target: 'concept-cards' },
      { key: 'quickAdd', target: 'quick-add' },
      // Last of the basics because it is the one that pays off on a shared
      // bench, and nobody discovers a keyboard shortcut by looking.
      { key: 'fastKey', target: 'fast-key', needsNav: true },
      // Straight after it, because the two answer the same question from
      // opposite ends: how do I get in quickly, and how do I stop being
      // signed out at all.
      { key: 'remember', target: 'remember-device', needsNav: true },
      { key: 'look', target: 'theme', needsNav: true },
      { key: 'help', target: 'help', needsNav: true },
    ],
  },
  {
    id: 'daily',
    steps: [
      { key: 'intro', route: '/items', target: 'items-table' },
      { key: 'filters', target: 'items-filters' },
      { key: 'sorting', target: 'items-table' },
      { key: 'drawer' },
      { key: 'statuses' },
      { key: 'request' },
    ],
  },
  {
    id: 'buying',
    steps: [
      { key: 'requests', route: '/requests', target: 'requests-list' },
      { key: 'lots', route: '/lots', target: 'lots-list' },
      { key: 'receive' },
      { key: 'forecast', route: '/forecast', target: 'forecast-list' },
      { key: 'loop' },
    ],
  },
  {
    id: 'equipment',
    steps: [
      { key: 'intro', route: '/' },
      { key: 'due', target: 'maintenance-due' },
      { key: 'tab' },
      { key: 'plans' },
      { key: 'places', route: '/locations', target: 'location-tree' },
    ],
  },
];
