chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (!res) return;

    if (res.ytm?.connected) {
        document.getElementById("ytm-row").classList.add("connected-ytm");
        const t = res.ytm.lastTrack;
        document.getElementById("ytm-track").textContent =
            t ? (t.artist ? `${t.title} — ${t.artist}` : t.title) : "Connected";
    }

    if (res.sc?.connected) {
        document.getElementById("sc-row").classList.add("connected-sc");
        const t = res.sc.lastTrack;
        document.getElementById("sc-track").textContent =
            t ? (t.artist ? `${t.title} — ${t.artist}` : t.title) : "Connected";
    }
});
