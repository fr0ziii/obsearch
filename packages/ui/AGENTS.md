# @obsearch/ui — Agent Reference

## OVERVIEW
Shared React component library for obsearch; thin wrappers over Base UI primitives, styled with Tailwind + cva.

## COMPONENTS

**Button** (`button.tsx`)
- Props: `variant` (`default|outline|secondary|ghost|destructive|link`), `size` (`default|xs|sm|lg|icon|icon-xs|icon-sm|icon-lg`), all `ButtonPrimitive.Props`
- Exports: `Button`, `buttonVariants`

**Card** (`card.tsx`)
- Props: `size` (`default|sm`) on `Card`; all sub-parts are plain `div` wrappers
- Exports: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`
- Slot composition: `CardHeader > CardTitle + CardDescription + CardAction`, `CardContent`, `CardFooter`

**Input** (`input.tsx`)
- Props: all `React.ComponentProps<"input">` — no custom variants
- Export: `Input`

**Label** (`label.tsx`)
- Props: all `React.ComponentProps<"label">`
- Export: `Label`

**Checkbox** (`checkbox.tsx`)
- Props: `CheckboxPrimitive.Root.Props` (Base UI)
- Export: `Checkbox`
- "use client" — requires client boundary

**Toaster** (`sonner.tsx`)
- Props: `ToasterProps` from sonner; auto-reads theme via `next-themes`
- Export: `Toaster` — mount once at app root
- "use client"

**Skeleton** (`skeleton.tsx`)
- Props: `React.ComponentProps<"div">`
- Export: `Skeleton` — `animate-pulse` div, use for loading states

**DropdownMenu** (`dropdown-menu.tsx`)
- Exports: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuPortal`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`
- `DropdownMenuItem` supports `variant: "default"|"destructive"` and `inset?: boolean`
- "use client"

## USAGE

Import pattern — always use package exports, never relative paths:
```ts
import { Button } from "@obsearch/ui/components/button"
import { Card, CardContent } from "@obsearch/ui/components/card"
import { cn } from "@obsearch/ui/lib/utils"
```

Global styles — import once in app entry:
```ts
import "@obsearch/ui/globals.css"
```

## CONVENTIONS

- **Primitives**: Base UI (`@base-ui/react/*`) for interactive components (Button, Input, Checkbox, DropdownMenu). Plain `div`/`label` for layout-only components.
- **Styling**: `cn()` (clsx + tailwind-merge) for all className merging. `cva` for multi-variant components — define variants in the file, export the variants object alongside the component.
- **No rounded corners**: all components use `rounded-none` by design — do not add `rounded-*` unless overriding intentionally.
- **data-slot**: every component sets `data-slot="<name>"` for parent-context styling hooks.
- **Adding a component**: create `src/components/<name>.tsx`, export from it, then use `@obsearch/ui/components/<name>` in consuming apps — no barrel file needed (package.json `exports` uses `./components/*` glob).
- **"use client"**: add directive only when the component uses hooks or browser APIs. Card, Input, Label, Skeleton do not need it.
- **Icons**: use `lucide-react` only. Default icon size is `size-4`; components handle `[&_svg:not([class*='size-'])]:size-4` automatically.
