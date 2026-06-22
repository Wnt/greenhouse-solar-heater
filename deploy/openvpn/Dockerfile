FROM alpine:3.24
RUN apk add --no-cache openvpn
# Alpine 3.24 ships OpenVPN 2.7+, which treats the TLS-less static-key
# (PSK) config as a hard "Options error" instead of a warning. UniFi
# site-to-site VPN only supports static-key mode, so we must opt back in
# with --allow-deprecated-insecure-static-crypto (see server.conf.example).
# Without it the sidecar crash-loops and the pod never goes Ready, taking
# the whole app offline (nginx 503).
CMD ["openvpn", "--config", "/etc/openvpn/server.conf", "--allow-deprecated-insecure-static-crypto"]
