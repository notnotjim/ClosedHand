# The same Workspace tools as Docker, with a Linux kernel for the Mac VM.
ARG WORKSPACE_IMAGE=ghcr.io/notnotjim/closedhand-sandbox:latest
FROM ${WORKSPACE_IMAGE}
USER root
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d && \
    apt-get update && apt-get install -y --no-install-recommends \
      linux-image-arm64 initramfs-tools busybox-static socat iproute2 iptables e2fsprogs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY sandbox-image/agent/ /app/
COPY desktop/workspace/guest/init.sh /usr/local/sbin/closedhand-init
COPY desktop/workspace/guest/poweroff.sh /usr/local/sbin/closedhand-poweroff
COPY desktop/workspace/guest/dhcp.sh /usr/local/sbin/closedhand-dhcp
COPY desktop/workspace/guest/browser.sh /usr/local/bin/chromium-launcher
RUN chmod 755 /usr/local/sbin/closedhand-* /usr/local/bin/chromium-launcher && \
    mkdir -p /run /workspace /dev/pts /dev/shm && \
    rm -rf /home/sandbox && ln -s /workspace/.home /home/sandbox && \
    printf 'virtio\nvirtio_pci\nvirtio_blk\nvirtio_net\nvmw_vsock_virtio_transport\next4\n' >> /etc/initramfs-tools/modules && \
    update-initramfs -u -k all
ENTRYPOINT []
CMD ["/usr/local/sbin/closedhand-init"]
