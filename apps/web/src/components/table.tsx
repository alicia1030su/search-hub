import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { classNames as cn } from "../lib/format";

export function Table({
  children,
  className,
  minWidth = "min-w-[720px]",
  caption,
}: {
  children: ReactNode;
  className?: string;
  minWidth?: string;
  caption?: string;
}) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border bg-card">
      <table className={cn("w-full caption-bottom text-sm", minWidth, className)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-muted/45">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="[&>tr:last-child>td]:border-0">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
  selected,
  id,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
  id?: string;
}) {
  return (
    <tr
      id={id}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        "border-b transition-colors",
        onClick ? "cursor-pointer hover:bg-accent/45 focus-visible:bg-accent/45" : undefined,
        selected ? "bg-accent/60" : undefined,
        className,
      )}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </tr>
  );
}

export function TH({
  children,
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={cn("px-3 py-2.5 align-middle text-sm", className)} {...props}>
      {children}
    </td>
  );
}
