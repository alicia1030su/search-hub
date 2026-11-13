import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { ToastProvider } from "./components/toast";
import { AuthProvider } from "./lib/session";
import { ThemeProvider } from "./lib/theme";

const container = document.getElementById("root");
if (!container) throw new Error("root container is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
