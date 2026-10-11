import DynamoDbLogo from "../assets/aws-dynamodb.svg";
import EventBridgeLogo from "../assets/aws-eventbridge.svg";
import MomentoCacheLogo from "../assets/momento-service-arch-icon-Cache.svg";
import MomentoTopicLogo from "../assets/momento-service-arch-icon-Topics.svg";
import { ArrowDown } from "../svgs/arrow-down";
import { ArrowLeft } from "../svgs/arrow-left";
import { ArrowRight } from "../svgs/arrow-right";
import { CornerLeftDown } from "../svgs/corner-left-down";
import { CornerRightDown } from "../svgs/corner-right-down";

function Step({ logo, name, note }: { logo: string; name: string; note?: string }) {
  return (
    <div className="flex items-center bg-white p-4 shadow-md rounded-lg">
      <img src={logo} alt="" className="w-6 h-6" />
      <div className="ml-2 flex flex-col">
        <span className="font-semibold">{name}</span>
        {note && <span className="text-xs text-gray-500">{note}</span>}
      </div>
    </div>
  );
}

// How a change travels from the table to the two panels below.
export default function FlowStrip() {
  return (
    <div className="flex flex-col items-center">
      <ArrowDown />
      <div className="flex flex-col md:flex-row items-center justify-center mt-2 space-y-2 md:space-y-0 md:space-x-4">
        <CornerLeftDown />
        <Step logo={MomentoTopicLogo} name="Momento Topic" />
        <ArrowLeft />
        <Step logo={EventBridgeLogo} name="EventBridge Pipes" note="publish" />
        <ArrowLeft />
        <Step logo={DynamoDbLogo} name="DynamoDB stream" />
        <ArrowRight />
        <Step logo={EventBridgeLogo} name="EventBridge Pipes" note="put, delete" />
        <ArrowRight />
        <Step logo={MomentoCacheLogo} name="Momento Cache" />
        <CornerRightDown />
      </div>
    </div>
  );
}
