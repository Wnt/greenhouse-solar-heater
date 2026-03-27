# Managed MySQL monitoring

The MySQL service offers a range of features to help you monitor and manage your services and integrations.

## Metrics

Our MySQL service provides metrics to give you insights into the performance and health of your databases. These metrics can be used to identify trends, detect anomalies, and optimize database performance.

## Logs

The MySQL service also offers logs that provide detailed information about database activity. You can use these logs to troubleshoot issues, track changes, and monitor system behavior.

## Alerts

Our MySQL service includes alerts that notify you of potential problems or issues with your databases via our alert [API](https://developers.upcloud.com/1.3/16-managed-database/#list-all-alerts). These alerts will trigger based on specific conditions, such as high CPU usage or disk reaching max capacity.

### Service Integrations

MySQL service can be integrated with other services and tools. With this feature, you can effortlessly export logs from your databases to an `OpenSearch` service or external log management systems using `Rsyslog`.

By exporting logs, you'll unlock a treasure trove of insights that will revolutionise your data analysis and decision-making. With a permanent record of database activity at your fingertips, you can:

- Conduct in-depth retrospectives to optimise performance and troubleshoot issues.
- Rapidly locate specific logs based on timestamp for swift problem resolution.
- Unlock the full potential of OpenSearch analytics and visualisation capabilities, revealing hidden trends and patterns.
- Confidently meet compliance requirements by retaining logs for a specified period, ensuring transparency and accountability.

### Rsyslog integration examples

You can configure integration endpoints with popular third-party platforms using UpCloud's MySQL service and Rsyslog. Below are examples of custom `logline` formats for each integration necessary in the [API](https://developers.upcloud.com/1.3/16-managed-database/#create-integration-endpoint) requests.

#### New Relic

For New Relic integration, use a custom `logline` format that incorporates your unique license key. This allows you to prefix your New Relic License Key and conform to the built-in Grok pattern for seamless integration.

- Server: `newrelic.syslog.eu.nr-data.net` (for EU region accounts) or `newrelic.syslog.nr-data.net` (for other regions)
- Port: 6514
- TLS: True
- Format: Custom
- Logline:

```
"YOUR_LICENSE_KEY <%pri%>%protocol-version% %timestamp:::date-rfc3339% %hostname% %app-name% %procid% %msgid% %structured-data% %msg%"
```

#### Loggly

For Loggly integration, use a custom `logline` format with your token.

- Server: `logs-01.loggly.com`
- Port: 6514
- TLS: True
- Format: Custom
- Logline:

```
"<%pri%>%protocol-version% %timestamp:::date-rfc3339% %HOSTNAME% %app-name% %procid% %msgid% TOKEN tag="RsyslogTLS"] %msg%"
```

#### Coralogix

- Server: `syslogserver.coralogix.com` (`.com` / `.us` / `.in`)
- Port: 5142
- TLS: False
- Format: Custom
- Logline:

```
"{\"fields\": {\"private_key\":\"YOUR_CORALOGIX_KEY\",\"company_id\":\"YOUR_COMPANY_ID\",\"app_name\":\"%app-name%\",\"subsystem_name\":\"programname\"},\"message\": {\"message\":\"%msg%\",\"program_name\":\"%programname%\",\"pri_text\":\"%pri%\",\"hostname\":\"%HOSTNAME%\"}}"
```

Note: TLS needs to be set to false.

#### Mezmo (LogDNA)

For Mezmo syslog integration, use a custom `logline` format with your key.

- Server: `syslog-a.logdna.com`
- Port: 6514
- TLS: True
- Format: Custom
- Logline:

```
"<%pri%>%protocol-version% %timestamp:::date-rfc3339% %HOSTNAME% %app-name% %procid% %msgid% [logdna@48950 key="YOUR_KEY_GOES_HERE"] %msg%"
```

#### Papertrail

When configuring Papertrail, simply copy the server and port values from your "Log Destinations" page and enter them accordingly. As Papertrail's servers are secured with certificates issued by trusted Certificate Authorities (CAs), you won't need to provide a CA bundle. Additionally, ensure the log format is set to `RFC3164`.

- Server: `logsN.papertrailapp.com`
- Port: XXXXX (copy from the "Log Destinations" page)
- Format: rfc3164

#### Sumo Logic

- Server: `syslog.collection.YOUR_DEPLOYMENT.sumologic.com` (replace `YOUR_DEPLOYMENT` with one of au, ca, de, eu, fed, in, jp, us1 or us2)
- Port: 6514
- Format: Custom
- Logline:

```
"<%pri%>%protocol-version% %timestamp:::date-rfc3339% %HOSTNAME% %app-name% %procid% %msgid% YOUR_TOKEN %msg%"
```

Note that these are just examples of custom logline formats and may need to be modified based on your specific use case.
