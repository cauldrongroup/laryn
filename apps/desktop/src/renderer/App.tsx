import { useMemo } from "react";
import MainView from "./MainView";
import OverlayView from "./OverlayView";

type View = "main" | "overlay";

export default function App() {
  const view = useMemo<View>(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const candidate = params.get("view") ?? hashParams.get("view");
    return candidate === "overlay" ? "overlay" : "main";
  }, []);

  if (view === "overlay") {
    return <OverlayView />;
  }

  return <MainView />;
}
