FROM python:3.12-slim

# Install Node.js 20 LTS + gosu (for entrypoint user switching) + Playwright system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gosu && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Pre-install Python packages (including Playwright, data science, and utilities)
RUN pip install --no-cache-dir \
    pandas numpy requests matplotlib beautifulsoup4 pillow openpyxl \
    playwright lxml scipy scikit-learn seaborn tabulate \
    python-dateutil pytz httpx pydantic chardet

# Browser (user-facing + automation target via CDP). Stock Google Chrome on
# amd64 (Chrome for Testing showed a permanent "automated testing only"
# banner); Google ships no arm64 Linux Chrome, so other arches get Debian's
# Chromium. chromium-launcher picks whichever binary exists.
RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg && \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg && \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get install -y --no-install-recommends chromium; \
    fi && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Minimal display stack: Xvfb + VNC + openbox (lightweight WM for browser window)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc python3-websockify \
    openbox \
    xdotool scrot fonts-liberation dbus-x11 procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# websockify serves this directory, and the novnc package ships no index, so
# the bare port answered with a file listing instead of the screen. Land
# anyone who opens it straight on the connected client.
RUN printf '%s' '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&resize=scale"><title>ClosedHand'"'"'s computer</title>' > /usr/share/novnc/index.html

# Copy gateway + browser Python helpers to importable path
COPY agent/gateway_client.py /usr/local/lib/python3.12/gateway_client.py
COPY agent/browser_helper.py /usr/local/lib/python3.12/browser_helper.py

# Openbox config (auto-maximize, no decorations)
COPY openbox-config/rc.xml /etc/xdg/openbox/rc.xml

# Chromium launcher
COPY chromium-launcher.sh /usr/local/bin/chromium-launcher
RUN chmod +x /usr/local/bin/chromium-launcher

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash sandbox && \
    mkdir -p /workspace && chown sandbox:sandbox /workspace

# Matplotlib: use non-interactive backend, writable config dir
ENV MPLBACKEND=Agg
ENV MPLCONFIGDIR=/tmp/matplotlib
ENV DISPLAY=:99

# Install agent
WORKDIR /app
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --production
COPY agent/ .

# Entrypoint fixes volume permissions then drops to sandbox user
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080 6080
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/server.js"]
