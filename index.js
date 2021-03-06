"use strict";
const path = require("path");

const electron = require("electron");
const is = require("electron-is");
const { autoUpdater } = require("electron-updater");

const { setApplicationMenu } = require("./menu");
const {
	autoUpdate,
	getEnabledPlugins,
	isAppVisible,
	isTrayEnabled,
	store,
	startAtLogin,
} = require("./store");
const { fileExists, injectCSS } = require("./plugins/utils");
const { isTesting } = require("./utils/testing");
const { setUpTray } = require("./tray");

const app = electron.app;
app.allowRendererProcessReuse = true; // https://github.com/electron/electron/issues/18397

// Adds debug features like hotkeys for triggering dev tools and reload
require("electron-debug")();

// Prevent window being garbage collected
let mainWindow;
autoUpdater.autoDownload = false;

let icon = "assets/youtube-music.png";
if (process.platform == "win32") {
	icon = "assets/generated/icon.ico";
} else if (process.platform == "darwin") {
	icon = "assets/generated/icon.icns";
}

function onClosed() {
	// Dereference the window
	// For multiple windows store them in an array
	mainWindow = null;
}

function createMainWindow() {
	const windowSize = store.get("window-size");
	const windowMaximized = store.get("window-maximized");

	const win = new electron.BrowserWindow({
		icon: icon,
		width: windowSize.width,
		height: windowSize.height,
		backgroundColor: "#000",
		show: false,
		webPreferences: {
			nodeIntegration: isTesting(), // Only necessary when testing with Spectron
			preload: path.join(__dirname, "preload.js"),
			nativeWindowOpen: true, // window.open return Window object(like in regular browsers), not BrowserWindowProxy
			enableRemoteModule: true,
			affinity: "main-window", // main window, and addition windows should work in one process
		},
		frame: !is.macOS(),
		titleBarStyle: is.macOS() ? "hiddenInset" : "default",
	});
	if (windowMaximized) {
		win.maximize();
	}

	win.webContents.loadURL(store.get("url"));
	win.on("closed", onClosed);

	injectCSS(win.webContents, path.join(__dirname, "youtube-music.css"));
	win.webContents.on("did-finish-load", () => {
		if (is.dev()) {
			console.log("did finish load");
			win.webContents.openDevTools();
		}
	});

	getEnabledPlugins().forEach((plugin) => {
		console.log("Loaded plugin - " + plugin);
		const pluginPath = path.join(__dirname, "plugins", plugin, "back.js");
		fileExists(pluginPath, () => {
			const handle = require(pluginPath);
			handle(win);
		});
	});

	win.webContents.on("did-fail-load", () => {
		if (is.dev()) {
			console.log("did fail load");
		}
		win.webContents.loadFile(path.join(__dirname, "error.html"));
	});

	win.webContents.on("will-prevent-unload", (event) => {
		event.preventDefault();
	});

	win.webContents.on("did-navigate-in-page", () => {
		const url = win.webContents.getURL();
		if (url.startsWith("https://music.youtube.com")) {
			store.set("url", url);
		}
	});

	win.webContents.on("will-navigate", (_, url) => {
		if (url.startsWith("https://accounts.google.com")) {
			// Force user-agent "Firefox Windows" for Google OAuth to work
			// From https://github.com/firebase/firebase-js-sdk/issues/2478#issuecomment-571356751
			// Only set on accounts.google.com, otherwise querySelectors in preload scripts fail (?)
			const userAgent =
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:70.0) Gecko/20100101 Firefox/70.0";

			win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
				details.requestHeaders["User-Agent"] = userAgent;
				cb({ requestHeaders: details.requestHeaders });
			});
		}
	});

	win.webContents.on(
		"new-window",
		(e, url, frameName, disposition, options) => {
			// hook on new opened window

			// at now new window in mainWindow renderer process.
			// Also, this will automatically get an option `nodeIntegration=false`(not override to true, like in iframe's) - like in regular browsers
			options.webPreferences.affinity = "main-window";
		}
	);

	win.on("move", () => {
		let position = win.getPosition();
		store.set("window-position", { x: position[0], y: position[1] });
	});

	win.on("resize", () => {
		const windowSize = win.getSize();

		store.set("window-maximized", win.isMaximized());
		if (!win.isMaximized()) {
			store.set("window-size", { width: windowSize[0], height: windowSize[1] });
		}
	});

	win.once("ready-to-show", () => {
		if (isAppVisible()) {
			win.show();
		}
	});

	return win;
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}

	// Unregister all shortcuts.
	electron.globalShortcut.unregisterAll();
});

app.on("activate", () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (mainWindow === null) {
		mainWindow = createMainWindow();
	} else if (!mainWindow.isVisible()) {
		mainWindow.show();
	}
});

app.on("ready", () => {
	mainWindow = createMainWindow();
	setApplicationMenu(mainWindow);
	setUpTray(app, mainWindow);

	// Autostart at login
	app.setLoginItemSettings({
		openAtLogin: startAtLogin(),
	});

	if (!is.dev() && autoUpdate()) {
		autoUpdater.checkForUpdatesAndNotify();
		autoUpdater.on("update-available", () => {
			const dialogOpts = {
				type: "info",
				buttons: ["OK"],
				title: "Application Update",
				message: "A new version is available",
				detail:
					"A new version is available and can be downloaded at https://github.com/th-ch/youtube-music/releases/latest",
			};
			electron.dialog.showMessageBox(dialogOpts);
		});
	}

	// Optimized for Mac OS X
	if (is.macOS()) {
		if (!isAppVisible()) {
			app.dock.hide();
		}
	}

	var forceQuit = false;
	app.on("before-quit", () => {
		forceQuit = true;
	});

	if (is.macOS() || isTrayEnabled()) {
		mainWindow.on("close", (event) => {
			// Hide the window instead of quitting (quit is available in tray options)
			if (!forceQuit) {
				event.preventDefault();
				mainWindow.hide();
			}
		});
	}
});
