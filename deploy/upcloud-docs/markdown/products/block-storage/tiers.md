# Block Storage tiers

UpCloud offers multiple storage tiers for different use cases.

## MaxIOPS

MaxIOPS® is our in-house developed storage technology that enables read performance of up to 100k IOPS at 4k block size. It's offered as the default storage tier for our General Purpose Cloud Servers. MaxIOPS provides the same performance level regardless of storage device size or plan pricing.

## Standard

Standard block storage tier offers a reliable and cost-effective solution for general-purpose storage needs. Designed to balance performance and affordability, this tier is ideal for a wide range of applications, including both development environments and production systems.

## Archive

Archive is the alternative when capacity and cost-effectiveness are more important than performance. It uses the same redundancy-ensured technology as our proprietary MaxIOPS storage but with high-capacity devices for low-cost storage.

**Note:** The name for this tier was changed from *HDD* to *Archive* in August 2024. For backwards compatibility, `hdd` continues to be used on the API and SDKs.

## Storage tier features

|  | MaxIOPS | Standard | Archive |
| --- | --- | --- | --- |
| Use case | High performance | General purpose | High capacity |
| Capacity | 1 GB – 4 TB | 1 GB - 4 TB | 1 GB – 4 TB |
| Performance (4k block size) | Read: 100 000 IOPS Write: 30 000 IOPS | Read: 10 000 IOPS Write: 10 000 IOPS | Read: 600 IOPS Write: 600 IOPS |
| Availability | All locations | All locations | All locations |

MaxIOPS is a registered trademark of UpCloud Ltd.
