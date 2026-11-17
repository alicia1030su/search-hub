import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plug,
  Search,
  Server,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { classNames as cn } from "../lib/format";
import { useAsyncData, useLocale } from "../lib/hooks";
import { availableLocales, setLocale, t, type MessageKey } from "../lib/i18n";
import { useAuth } from "../lib/session";
import { useTheme } from "../lib/theme";
import { useToast } from "../components/toast";
import { Badge, Button } from "../components/ui";

interface NavItem {
  to: string;
  label: MessageKey;
  icon: typeof Activity;
  end?: boolean;
}

const sections: Array<{ title: MessageKey; items: NavItem[] }> = [
  {
    title: "nav.section.manage",
    items: [
      { to: "/", label: "nav.dashboard", icon: LayoutDashboard, end: true },
      { to: "/providers", label: "nav.providers", icon: Server },
      { to: "/models", label: "nav.models", icon: Cpu },
    ],
  },
  {
    title: "nav.section.test",
    items: [{ to: "/lab", label: "nav.lab", icon: FlaskConical }],
  },
  {
    title: "nav.section.system",
    items: [
      { to: "/integrations", label: "nav.integrations", icon: Plug },
      { to: "/settings", label: "nav.settings", icon: Settings },
    ],
  },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { setupStatus } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Search className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">Search Hub</p>
          <p className="truncate text-[10px] leading-tight text-muted-foreground">
            {t("app.tagline")}
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label={t("nav.mainNavigation")}>
        {sections.map((section) => (
          <div key={section.title}>
            <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
              {t(section.title)}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                          isActive
                            ? "bg-primary/8 font-medium text-foreground"
                            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        )
                      }
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span>{t(item.label)}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t px-4 py-3 text-[11px] text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span>v{setupStatus?.version ?? "0.1.0"}</span>
          <span className={cn("inline-flex items-center gap-1", setupStatus ? "text-success" : "text-muted-foreground")}>
            <span className={cn("size-1.5 rounded-full", setupStatus ? "bg-success" : "bg-muted-foreground")} />
            {setupStatus ? t("nav.apiConnected") : t("nav.apiDisconnected")}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { user, logout, setupStatus } = useAuth();
  const { theme, toggle } = useTheme();
  const toast = useToast();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const settings = useAsyncData((signal) => api.settings(signal), []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onSettingsUpdated = () => settings.reload();
    window.addEventListener("sh:settings-updated", onSettingsUpdated);
    return () => window.removeEventListener("sh:settings-updated", onSettingsUpdated);
    // reload is stable; re-subscribing only when the loader changes
  }, [settings.reload]);

  const instanceName = settings.data?.instance.name || "Search Hub";

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[90] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t("nav.skipToContent")}
      </a>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r bg-sidebar lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="animate-fade-in absolute inset-0 bg-[var(--overlay)]"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="animate-slide-in absolute inset-y-0 left-0 w-64 border-r bg-sidebar shadow-2xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label={t("nav.closeMenu")}
              className="absolute right-2 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label={t("nav.openMenu")}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{instanceName}</span>
              <Badge tone="outline" className="hidden sm:inline-flex">
                v{setupStatus?.version ?? "0.1.0"}
              </Badge>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{t("app.tagline")}</p>
          </div>

          <div className="flex items-center gap-1.5">
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label={t("theme.toggle")}
              title={theme === "dark" ? t("theme.light") : t("theme.dark")}
            >
              {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </Button>
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-xs font-medium leading-tight">{user?.name}</p>
              <p className="truncate text-[10px] leading-tight text-muted-foreground">{user?.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("auth.logout")}
              aria-label={t("auth.logout")}
              onClick={() => {
                void logout().then(() => toast.success({ title: t("auth.logoutDone") }));
              }}
            >
              <LogOut aria-hidden />
            </Button>
          </div>
        </header>

        <main id="main-content" className="mx-auto w-full max-w-[1440px] px-3 py-5 sm:px-5 lg:px-7 lg:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Language switcher.
 *
 * A native `<select>` on purpose: it is keyboard accessible, works without
 * extra JavaScript, and the E2E test can drive it with `selectOption`.
 */
function LanguageSwitcher() {
  const { locale } = useLocale();
  return (
    <label className="relative">
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as "zh-CN" | "en-US")}
        aria-label={t("common.language")}
        data-testid="locale-switcher"
        className="h-7 cursor-pointer rounded-md border border-input bg-transparent px-1.5 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {availableLocales().map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
