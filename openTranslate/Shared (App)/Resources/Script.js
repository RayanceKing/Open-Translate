function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        const on = document.querySelector('.platform-mac.state-on');
        const off = document.querySelector('.platform-mac.state-off');
        const unknown = document.querySelector('.platform-mac.state-unknown');
        const preferences = document.querySelector('.platform-mac.open-preferences');
        if (on) on.innerText = "openTranslate’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        if (off) off.innerText = "openTranslate’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        if (unknown) unknown.innerText = "You can turn on openTranslate’s extension in the Extensions section of Safari Settings.";
        if (preferences) preferences.innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

function openSettings() {
    webkit.messageHandlers.controller.postMessage("open-settings");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
document.querySelector("button.open-settings").addEventListener("click", openSettings);
