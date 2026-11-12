function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        const on = document.querySelector('.platform-mac.state-on');
        const off = document.querySelector('.platform-mac.state-off');
        const unknown = document.querySelector('.platform-mac.state-unknown');
        const preferences = document.querySelector('.platform-mac.open-preferences');
        if (on) on.innerText = "OpenTranslate 的拓展已启用。您可以在Safari设置中的扩展功能部分关闭它。";
        if (off) off.innerText = "OpenTranslate 的拓展已关闭。您可以在Safari设置中的扩展功能部分开启它。";
        if (unknown) unknown.innerText = "您可以在Safari设置中的扩展功能区开启OpenTranslate扩展功能.";
        if (preferences) preferences.innerText = "退出并打开 Safari 扩展…";
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
