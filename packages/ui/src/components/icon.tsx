import { icons, type LucideProps } from 'lucide-react';
import { categoryColor, cn } from '../utils';

const toPascal = (name: string) =>
  name
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');

export type IconName = string;

/** A lucide icon by its kebab-case name (as used in the activity catalog). */
export function Icon({ name, ...props }: { name: IconName } & LucideProps) {
  const Component = icons[toPascal(name) as keyof typeof icons] ?? icons.Square;
  return <Component strokeWidth={1.75} aria-hidden="true" {...props} />;
}

export function hasIcon(name: string): boolean {
  return toPascal(name) in icons;
}

/** Colored square with a category icon, used for steps and categories. */
export function IconTile({
  name,
  category,
  size = 'md',
  className,
}: {
  name: IconName;
  category?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const color = categoryColor(category);
  const box = { sm: 'h-6 w-6 rounded', md: 'h-8 w-8 rounded-md', lg: 'h-10 w-10 rounded-lg' }[size];
  const icon = { sm: 14, md: 17, lg: 20 }[size];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      <Icon name={name} size={icon} />
    </span>
  );
}
