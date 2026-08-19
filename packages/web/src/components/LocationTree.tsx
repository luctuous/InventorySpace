import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Factory, DoorOpen, Package, Pin } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import type { LocationLevel, LocationWithCount } from '@inventory/shared';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// One tree component, three uses: the Locations page, the location picker
// modal, and the Home filter ( — the tree doubles as a filter).

export interface LocationNode extends LocationWithCount {
  children: LocationNode[];
  subtreeItemCount: number;
}

export function buildTree(flat: LocationWithCount[]): LocationNode[] {
  const nodes = new Map<string, LocationNode>(
    flat.map((row) => [row.id, { ...row, children: [], subtreeItemCount: row.itemCount }]),
  );
  const roots: LocationNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sum = (node: LocationNode): number => {
    node.subtreeItemCount = node.itemCount + node.children.reduce((a, ch) => a + sum(ch), 0);
    return node.subtreeItemCount;
  };
  roots.forEach(sum);
  return roots;
}

const LEVEL_ICON: Record<LocationLevel, typeof Factory> = {
  site: Factory,
  room: DoorOpen,
  zone: Package,
  surface: Pin,
};

interface TreeProps {
  locations: LocationWithCount[];
  selectedId?: string | null;
  onSelect?: (node: LocationNode) => void;
  showCounts?: boolean;
  renderActions?: (node: LocationNode) => React.ReactNode;
}

function TreeNode({
  node,
  depth,
  props,
}: {
  node: LocationNode;
  depth: number;
  props: TreeProps;
}) {
  const { locale } = useI18n();
  const [expanded, setExpanded] = useState(depth < 2);
  const Icon = LEVEL_ICON[node.level];
  const selected = props.selectedId === node.id;

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm',
          props.onSelect && 'cursor-pointer',
          selected ? 'bg-primary-tint text-primary' : 'text-text hover:bg-surface-2',
        )}
        style={{ paddingLeft: `${depth * 1.1 + 0.375}rem` }}
        onClick={() => props.onSelect?.(node)}
      >
        <button
          type="button"
          className={cn(
            'flex h-4 w-4 items-center justify-center text-muted cursor-pointer',
            node.children.length === 0 && 'invisible',
          )}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-primary' : 'text-muted')} />
        <span className="human-id">{node.code}</span>
        <span className="truncate">{resolveText(node.name, locale)}</span>
        {props.showCounts && node.subtreeItemCount > 0 && (
          <span className="ml-auto font-mono text-xs text-muted">{node.subtreeItemCount}</span>
        )}
        {props.renderActions && (
          <span
            className={cn('opacity-0 group-hover:opacity-100', !props.showCounts && 'ml-auto')}
            onClick={(e) => e.stopPropagation()}
          >
            {props.renderActions(node)}
          </span>
        )}
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeNode key={child.id} node={child} depth={depth + 1} props={props} />
        ))}
    </div>
  );
}

export function LocationTree(props: TreeProps) {
  const roots = useMemo(() => buildTree(props.locations), [props.locations]);
  return (
    <div className="space-y-0.5">
      {roots.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} props={props} />
      ))}
    </div>
  );
}
