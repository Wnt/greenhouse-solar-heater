# 2FA - Two-factor authentication

Having a good, difficult-to-guess, password for logging into your UpCloud control panel is essential for keeping your account secure, but for an additional layer of security, UpCloud supports two-factor authentication also known as 2FA.

## What is two-factor authentication?

Two-factor authentication is a method of verifying the user using two different types of validity checks, often by asking for something only the user knows and something only they possess. Bank cards are a good example of everyday use of 2FA where the card is something physical the user has and the pin number a secret only they know.

![Log in with two-factor authentication](img/image.png)

Log in with two-factor authentication

At UpCloud you already have a username and a password that are something only you know. The second factor in user authentication can be a smartphone, a personal item that almost everyone carries around with them on a daily basis. To use your smartphone for 2FA you will need to download and install an authenticator application. Here are some examples of supported mobile applications:

- [Google Authenticator](http://support.google.com/accounts/bin/answer.py?hl=en&answer=1066447) (Android/iPhone)
- [Duo Mobile](http://guide.duosecurity.com/third-party-accounts) (Android/iPhone)

Below you can find detailed instructions on how to connect an authenticator application with your UpCloud account.

## Enabling 2FA

Log in to your [UpCloud control panel](https://hub.upcloud.com/account/overview) and go to your *Account overview*.

Before activating the two-factor authentication, check that your phone number is registered correctly in your account details. This is important in the event that you lose access to your authenticator app, for example, if your phone is lost or damaged.

![Account details](img/image-1.png)

Account details

Enable the *Two-factor authentication* by clicking the toggle switch below the Password section. Turning on the 2FA on your account opens a new *Setup* button next to the selection box, click it to open the configurations.

![Configure two-factor authentication](img/image-2.png)

Configure two-factor authentication

1. In the 2FA configurations window, you will see a shared secret key for connecting an authenticator application on your smartphone with your UpCloud account and a QR code matching the key.
2. If you do not already have an authenticator application installed on your phone, you can find a couple of popular options available for multiple mobile operating systems on the right side information panel. By following one of the links you can find detailed instructions on how to install an authenticator on your phone.
3. Once you have an appropriate application installed, open it and follow the in-application instructions on how to set up a new account using either the key or the QR code displayed in the 2FA configuration window.
4. When the authenticator is ready, enter a code as displayed in the authenticator app in the 2FA configuration window and click *Submit* to activate the feature.

![Google authenticator](img/image-3.png)

Google authenticator

When you click Submit, the configuration window will close and you’ll see a notification that two-factor authentication has been set up successfully.

Now next time you log in to your UpCloud control panel you will be asked for a one-time password that you can find in your authenticator application similar to the example picture of Google Authenticator shown above.

## 2FA for team members

Group accounts can also benefit from two-factor authentication. Each account under your main account can enable 2FA individually in their account options.

Follow the instructions in the above section about Enabling 2FA.

Depending on your authenticator application you can choose to either scan the QR code from your screen with your smartphone or enter the 16-digit key code manually. Regardless of the method, once entered verifying your authenticator will then show a 6-digit passcode for a limited time per code as indicated by a timer icon next to it.

## If you lose your authenticator

Do not worry if you changed your phone or accidentally uninstall the application. As a backup, you can have the authentication code delivered to you via an SMS or a phone call to the phone number registered to your account.

Enter your username and password as usual but in the Two-factor authentication window just click *Submit* once to reveal the *I don’t have a code* button and click it.

![2FA wrong code](img/image-4.png)

2FA wrong code

Then click one of the two options to have the code either sent to you by SMS or automated phone call. When you get the one-time backup code, enter it in the field below to log in.

![2FA backup code options](img/image-5.png)

2FA backup code options

Afterwards, go into your *Accounts* menu to reconfigure your authenticator application to use the authentication codes again when logging in the next time.

## Conclusions

Your phone now works as the second factor in the authentication process. Keep it at hand when logging in to your UpCloud control panel and rest assured your account is secure. While it is possible to install an authenticator application on your computer, it is not advised for security reasons as the authenticator should be kept separate from the device you use to log into your control panel.

The 2FA at UpCloud utilises a time-based one-time password algorithm, this means the code in the authenticator application is time sensitive and keeps changing every 30 seconds. Being time-based means only the code currently displayed in the application will work and that the codes cannot be written down to be used at a later time. For the timed codes to work, your phone must be able to keep its clock synchronised, which most devices do by default.

If you are having difficulties with the authentication code not working, check that the time and date on your phone are correct. If that doesn’t fix the issue, log in using the backup options and reconfigure your authenticator app following the same steps as you did originally.
