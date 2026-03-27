# Connecting to your Cloud Server over VNC

Virtual Network Computing (VNC) enables remote desktop access to your server. This guide walks you through setting up VNC access, allowing you to control your server as if you were physically present.

While VNC provides graphical remote access, it's worth noting that SSH is typically the recommended method for connecting to a headless Cloud Server. SSH offers better performance and security, and is generally better suited for server management. You should consider VNC when you need graphical access to servers with a desktop environment installed.

For SSH connection instructions, see our guide on connecting via [SSH](/docs/guides/connecting-to-your-server#openssh.md).

## Prerequisites

Before you begin, ensure you have:

- A Linux or Windows server
- Administrator or root access to your server
- A VNC client installed on your local machine such as [RealVNC Viewer](https://www.realvnc.com/en/connect/download/viewer/), [TigerVNC](https://tigervnc.org/), or [UltraVNC](https://uvnc.com/)

## Security considerations

- Use strong passwords for both VNC and server access
- Enable encryption for all VNC connections
- Configure firewall rules to restrict VNC access
- Regular password rotation is recommended
- Monitor access logs for unauthorized attempts

## Setup instructions

Select the server you want to enable VNC access on from the Control Panel.

![example-server](example-server.png)

Navigate to the server's **Console** tab in the Control Panel.

![console-tab](console-tab.png)

Locate the VNC connections toggle at the bottom of the page. Switch the VNC toggle to the "ON" position.

![enable-vnc](enable-vnc.png)

Note the automatically assigned VNC address and port.

You can use the pre-generated VNC password provided in the Control Panel, or you can change it to a strong, unique password of your choice.

Enabling/disabling VNC console as well as changing the VNC password can be done with the Cloud Server running. However, changing the keyboard map will require the server to be powered down.

![vnc-address-and-port](vnc-address-and-port.png)

## VNC client configuration

Launch your VNC viewer application. Click “New Connection” or an equivalent option. For this guide, we’ll use RealVNC Viewer.

Enter the VNC address and port in the format: `address:port`

![vnc-connect](vnc-connect.png)

You'll receive a security warning about the connection. This is normal for first-time connections. Press Continue.

![vnc-warning](vnc-warning.png)

Now you are prompted for your VNC password. This is your VNC-specific password from the Control Panel, not your server password. Keep this password secure and don't share it.

![vnc-authentication](vnc-authentication.png)

## Server login

Once connected, you'll see the server's login screen.

Log in using your root credentials

- Username: root
- Password: Your server's root password

If you haven't set a root password, connect via SSH first and use the `passwd` command. If you have forgotten your password, please refer to our [Linux](/docs/guides/reset-root-password-cloud-server.md) or [Windows](/docs/guides/reset-windows-administrator-password.md) password reset guides respectively.

![vnc-connected](vnc-connected.png)

If VNC doesn't meet your needs, consider [these alternatives](/docs/guides/connecting-to-your-server.md).
