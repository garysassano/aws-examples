import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ToastContainer } from "react-toastify";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

ReactDOM.createRoot(root).render(
  <>
    <App />
    <ToastContainer />
  </>,
);
