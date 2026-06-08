# @octo/web-ui-corp

Corporate Fiori-based variant of [`@octo/web-ui`](../web-ui-component).

This package is intentionally cloned from the existing web UI package so `web-app` can later switch from `@octo/web-ui` to `@octo/web-ui-corp` with the same chat-oriented public API. The corporate variant adds UI5 Web Components for React v2, UI5 Fiori assets, and Fiori theme token mapping in `app.css`.

## Usage

```ts
import {
	CoreServiceChatPanel,
	CoreServiceClient,
	configureFioriTheme,
	translations,
} from "@octo/web-ui-corp";
import "@octo/web-ui-corp/app.css";

await configureFioriTheme();
```

The default export surface mirrors `@octo/web-ui`; the additional `configureFioriTheme` helper loads the SAP Horizon theme through UI5.

## Fiori React Entry Point

React applications can use the UI5 React wrapper through the `./fiori` subpath:

```tsx
import { Button, ThemeProvider } from "@octo/web-ui-corp/fiori";
```

The package pins UI5 runtime packages to the 2.22 line to satisfy the `@ui5/webcomponents-react@2.22.2` peer dependency range.

## Build

```bash
npm run build --workspace @octo/web-ui-corp
```
