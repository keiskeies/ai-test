import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
ReactDOM.createRoot(el).render(<React.StrictMode><App /></React.StrictMode>);
